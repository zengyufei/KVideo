const LEGACY_CACHE_PREFIXES = ['video-cache-'];
const DOWNLOAD_PATH = '/__kvideo-download/';
const downloadStreams = new Map();

function downloadHeaders(filename, mimeType) {
    const safeFilename = String(filename || 'video').replace(/[\\"\r\n]/g, '_');
    return {
        'Content-Type': mimeType || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`,
        'Cache-Control': 'no-store',
    };
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
            stream: data.stream,
            filename: data.filename,
            mimeType: data.mimeType,
            done,
            finish,
        });
        // Keep the worker alive until the page closes or aborts this transferred stream.
        // Without this, a browser may discard the worker before the download URL consumes it.
        event.waitUntil(done);
        port?.postMessage({ type: 'ready' });
        return;
    }

    if (data.type === 'kvideo-download-close' || data.type === 'kvideo-download-abort') {
        const record = downloadStreams.get(data.id);
        record?.finish();
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

    event.respondWith(new Response(record.stream, {
        headers: downloadHeaders(record.filename, record.mimeType),
    }));
    event.waitUntil(record.done.then(() => {
        downloadStreams.delete(id);
    }));
});
