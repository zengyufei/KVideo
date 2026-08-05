'use client';

export const BROWSER_DOWNLOAD_PATH = '/__kvideo-download/';
const DOWNLOAD_ATTACH_TIMEOUT_MS = 5000;

export interface BrowserDownloadSession {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

interface BrowserDownloadOptions {
  filename: string;
  mimeType: string;
}

function createDownloadId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function waitForDownloadServiceWorker(): Promise<ServiceWorker> {
  return new Promise(async (resolve, reject) => {
    if (!('serviceWorker' in navigator) || typeof TransformStream === 'undefined') {
      reject(new Error('当前浏览器不支持大文件流式下载，请使用桌面 Chrome 或 Edge'));
      return;
    }

    try {
      await navigator.serviceWorker.ready;
      if (navigator.serviceWorker.controller) {
        resolve(navigator.serviceWorker.controller);
        return;
      }

      const timeout = window.setTimeout(() => {
        reject(new Error('下载服务正在初始化，请刷新页面后重试'));
      }, 3000);
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        window.clearTimeout(timeout);
        if (navigator.serviceWorker.controller) {
          resolve(navigator.serviceWorker.controller);
        } else {
          reject(new Error('下载服务初始化失败，请刷新页面后重试'));
        }
      }, { once: true });
    } catch {
      reject(new Error('下载服务初始化失败，请刷新页面后重试'));
    }
  });
}

function toDownloadError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

export async function createBrowserDownloadSession({
  filename,
  mimeType,
}: BrowserDownloadOptions): Promise<BrowserDownloadSession> {
  const worker = await waitForDownloadServiceWorker();
  const id = createDownloadId();
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  const channel = new MessageChannel();
  const timers = window;
  let downloadFrame: HTMLIFrameElement | undefined;

  let resolveReady: () => void;
  let rejectReady: (error: Error) => void;
  let resolveAttached: () => void;
  let rejectAttached: (error: Error) => void;
  let terminalError: Error | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
    const timeout = timers.setTimeout(() => {
      reject(new Error('浏览器下载服务没有响应，请刷新页面后重试'));
    }, 3000);
    const settleReady = (error?: Error) => {
      timers.clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    resolveReady = () => settleReady();
    rejectReady = (error) => settleReady(error);
  });

  const downloadAttached = new Promise<void>((resolve, reject) => {
    resolveAttached = resolve;
    rejectAttached = reject;
  });
  // An early Service Worker error can arrive before this promise is awaited.
  void downloadAttached.catch(() => undefined);

  const failSession = (error: Error) => {
    if (terminalError) return;
    terminalError = error;
    rejectAttached(error);
    void writer.abort(error).catch(() => undefined);
  };

  channel.port1.onmessage = (event: MessageEvent<{ type?: string; message?: string }>) => {
    const error = new Error(event.data?.message || '浏览器下载服务初始化失败');
    switch (event.data?.type) {
      case 'ready':
        resolveReady();
        break;
      case 'attached':
        resolveAttached();
        break;
      case 'streaming':
      case 'closed':
        break;
      case 'aborted':
        failSession(new Error(event.data?.message || '浏览器下载已取消或下载流已断开'));
        break;
      case 'error':
        rejectReady(error);
        failSession(error);
        break;
      default:
        rejectReady(error);
        failSession(error);
    }
  };

  try {
    worker.postMessage({
      type: 'kvideo-download-create',
      id,
      filename,
      mimeType,
      stream: stream.readable,
    }, [stream.readable, channel.port2]);
    await ready;

    downloadFrame = document.createElement('iframe');
    downloadFrame.hidden = true;
    downloadFrame.src = `${BROWSER_DOWNLOAD_PATH}${encodeURIComponent(id)}`;
    document.body.appendChild(downloadFrame);

    const attachmentTimeout = timers.setTimeout(() => {
      failSession(new Error('下载栏未连接到下载流，请强制刷新页面后重试'));
    }, DOWNLOAD_ATTACH_TIMEOUT_MS);
    try {
      await downloadAttached;
    } finally {
      timers.clearTimeout(attachmentTimeout);
    }
  } catch (error) {
    const downloadError = toDownloadError(error, '当前浏览器不支持流式下载，请使用最新版桌面 Chrome 或 Edge');
    failSession(downloadError);
    worker.postMessage({ type: 'kvideo-download-abort', id });
    downloadFrame?.remove();
    channel.port1.close();
    throw downloadError;
  }

  const finish = (type: 'kvideo-download-close' | 'kvideo-download-abort') => {
    worker.postMessage({ type, id });
  };

  return {
    async write(chunk) {
      if (terminalError) throw terminalError;
      await writer.write(chunk);
      if (terminalError) throw terminalError;
    },
    async close() {
      if (terminalError) throw terminalError;
      await writer.close();
      finish('kvideo-download-close');
      channel.port1.close();
    },
    async abort(reason) {
      await writer.abort(reason).catch(() => undefined);
      finish('kvideo-download-abort');
      downloadFrame?.remove();
      channel.port1.close();
    },
  };
}

export function startDirectBrowserDownload(url: string, filename: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export function createDownloadFilename(name: string, extension?: string): string {
  const baseName = name.replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 180) || 'video';
  return extension ? `${baseName}.${extension}` : baseName;
}

export function getUrlFileExtension(url: string): string | undefined {
  try {
    const filename = new URL(url).pathname.split('/').pop() || '';
    const match = filename.match(/\.([a-zA-Z0-9]{1,10})$/);
    return match?.[1]?.toLowerCase();
  } catch {
    return undefined;
  }
}
