'use client';

export const BROWSER_DOWNLOAD_PATH = '/__kvideo-download/';

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

export async function createBrowserDownloadSession({
  filename,
  mimeType,
}: BrowserDownloadOptions): Promise<BrowserDownloadSession> {
  const worker = await waitForDownloadServiceWorker();
  const id = createDownloadId();
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  const channel = new MessageChannel();

  const ready = new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error('浏览器下载服务没有响应，请刷新页面后重试'));
    }, 3000);

    channel.port1.onmessage = (event: MessageEvent<{ type?: string; message?: string }>) => {
      window.clearTimeout(timeout);
      if (event.data?.type === 'ready') {
        resolve();
      } else {
        reject(new Error(event.data?.message || '浏览器下载服务初始化失败'));
      }
    };
  });

  try {
    worker.postMessage({
      type: 'kvideo-download-create',
      id,
      filename,
      mimeType,
      stream: stream.readable,
    }, [stream.readable, channel.port2]);
    await ready;
  } catch (error) {
    await writer.abort(error).catch(() => undefined);
    throw new Error('当前浏览器不支持流式下载，请使用最新版桌面 Chrome 或 Edge');
  } finally {
    channel.port1.close();
  }

  const anchor = document.createElement('a');
  anchor.href = `${BROWSER_DOWNLOAD_PATH}${encodeURIComponent(id)}`;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  const finish = (type: 'kvideo-download-close' | 'kvideo-download-abort') => {
    worker.postMessage({ type, id });
  };

  return {
    write: (chunk) => writer.write(chunk),
    async close() {
      await writer.close();
      finish('kvideo-download-close');
    },
    async abort(reason) {
      await writer.abort(reason).catch(() => undefined);
      finish('kvideo-download-abort');
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
