const LEGACY_CACHE_PREFIXES = ['video-cache-'];
const DOWNLOAD_PATH = '/__kvideo-download/';
const DOWNLOAD_PROTOCOL_VERSION = 2;
const downloadStreams = new Map();

function downloadHeaders(filename, mimeType) {
    const safeFilename = String(filename || 'video').replace(/[\\"\r\n]/g, '_');
    return {
        'Content-Type': mimeType || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`,
        'Cache-Control': 'no-store',
    };
}

function notify(record, type, message) {
    try {
        record.port?.postMessage({ type, ...(message ? { message } : {}) });
    } catch {
        // The page can disappear while the browser continues its download.
    }
}

function finishDownload(record, state, message) {
    if (record.finished) return;

    record.finished = true;
    record.state = state;
    if (state === 'aborted' && record.reader) {
        void record.reader.cancel(message).catch(() => undefined);
    }
    if (state === 'aborted') notify(record, 'aborted', message || '浏览器下载已取消或下载流已断开');
    if (state === 'closed') notify(record, 'closed');
    downloadStreams.delete(record.id);
    record.finish();
}

self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((cacheNames) => Promise.all(
                cacheNames
                    .filter((cacheName) => LEGACY_CACHE_PREFIXES.some((prefix) => cacheName.startsWith(prefix)))
                    .map((cacheName) => caches.delete(cacheName))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('message', (event) => {
    const data = event.data || {};

    if (data.type === 'kvideo-skip-waiting') {
        self.skipWaiting();
        return;
    }

    if (data.type === 'kvideo-download-probe') {
        event.ports[0]?.postMessage({ type: 'protocol', version: DOWNLOAD_PROTOCOL_VERSION });
        return;
    }

    if (data.type === 'kvideo-download-create') {
        const port = event.ports[0];
        if (!data.id || !data.stream || typeof data.stream.getReader !== 'function') {
            port?.postMessage({ type: 'error', message: '下载流初始化失败' });
            return;
        }

        let finish;
        const done = new Promise((resolve) => {
            finish = resolve;
        });
        downloadStreams.set(data.id, {
            id: data.id,
            stream: data.stream,
            filename: data.filename,
            mimeType: data.mimeType,
            port,
            state: 'created',
            done,
            finish,
            finished: false,
        });
        // Keep the worker alive until the page closes or aborts this transferred stream.
        // Without this, a browser may discard the worker before the download URL consumes it.
        event.waitUntil(done);
        port?.postMessage({ type: 'ready', version: DOWNLOAD_PROTOCOL_VERSION });
        return;
    }

    if (data.type === 'kvideo-download-abort') {
        const record = downloadStreams.get(data.id);
        if (!record) return;
        finishDownload(record, 'aborted', '下载已取消');
    }
});

self.addEventListener('fetch', (event) => {
    const requestUrl = new URL(event.request.url);
    if (event.request.method !== 'GET' || requestUrl.origin !== self.location.origin || !requestUrl.pathname.startsWith(DOWNLOAD_PATH)) {
        return;
    }

    const id = decodeURIComponent(requestUrl.pathname.slice(DOWNLOAD_PATH.length));
    const record = downloadStreams.get(id);
    if (!record) {
        event.respondWith(new Response('Download stream not found', { status: 404 }));
        return;
    }

    if (record.state !== 'created') {
        event.respondWith(new Response('Download stream is already attached', { status: 409 }));
        return;
    }

    record.reader = record.stream.getReader();
    record.state = 'attached';
    const responseStream = new ReadableStream({
        async pull(controller) {
            try {
                const { done, value } = await record.reader.read();
                if (done) {
                    controller.close();
                    finishDownload(record, 'closed');
                    return;
                }
                if (record.state === 'attached') {
                    record.state = 'streaming';
                    notify(record, 'streaming');
                }
                controller.enqueue(value);
            } catch (error) {
                controller.error(error);
                finishDownload(record, 'aborted', '下载流读取失败');
            }
        },
        async cancel() {
            finishDownload(record, 'aborted', '浏览器下载已取消或下载流已断开');
        },
    });

    event.respondWith(new Response(responseStream, {
        headers: downloadHeaders(record.filename, record.mimeType),
    }));
    notify(record, 'attached');
    event.waitUntil(record.done.then(() => {
        downloadStreams.delete(id);
    }));
});
