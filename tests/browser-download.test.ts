import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserDownloadSession } from '@/lib/player/browser-download';

interface BrowserMock {
  workerMessages: Array<{ type?: string }>;
  attachmentPort?: MessagePort;
  attachmentTimeout?: () => void;
  anchorClicked: boolean;
  restore(): void;
}

async function waitFor<T>(getValue: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const value = getValue();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('测试下载桥接超时');
}

function installBrowserMock({ startWithLegacyWorker = false }: { startWithLegacyWorker?: boolean } = {}): BrowserMock {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const workerMessages: Array<{ type?: string }> = [];
  let attachmentPort: MessagePort | undefined;
  let attachmentTimeout: (() => void) | undefined;
  let downloadFrameInserted = false;
  const controllerChangeListeners = new Set<() => void>();
  const currentWorker = {
    postMessage(message: { type?: string }, transfers?: Transferable[]) {
      workerMessages.push(message);
      if (message.type === 'kvideo-download-probe') {
        const port = transfers?.[0] as MessagePort | undefined;
        queueMicrotask(() => port?.postMessage({ type: 'protocol', version: 2 }));
        return;
      }
      if (message.type !== 'kvideo-download-create') return;

      attachmentPort = transfers?.[1] as MessagePort | undefined;
      queueMicrotask(() => attachmentPort?.postMessage({ type: 'ready', version: 2 }));
    },
  };
  const legacyWorker = {
    postMessage(message: { type?: string }, transfers?: Transferable[]) {
      workerMessages.push(message);
      if (message.type !== 'kvideo-download-probe') return;

      const port = transfers?.[0] as MessagePort | undefined;
      queueMicrotask(() => port?.postMessage({ type: 'protocol', version: 1 }));
    },
  };
  let controller = startWithLegacyWorker ? legacyWorker : currentWorker;
  const serviceWorker = {
    ready: Promise.resolve(undefined),
    get controller() { return controller; },
    addEventListener(type: string, listener: () => void) {
      if (type === 'controllerchange') controllerChangeListeners.add(listener);
    },
    removeEventListener(type: string, listener: () => void) {
      if (type === 'controllerchange') controllerChangeListeners.delete(listener);
    },
    async getRegistration() {
      return {
        async update() {
          controller = currentWorker;
          controllerChangeListeners.forEach((listener) => listener());
        },
      };
    },
  };
  const frame = {
    hidden: false,
    src: '',
    remove() {},
  };

  const replaceGlobal = (name: string, value: unknown) => {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  };

  replaceGlobal('navigator', { serviceWorker });
  replaceGlobal('window', {
    setTimeout(callback: () => void, timeout: number) {
      if (timeout === 5000) attachmentTimeout = callback;
      return timeout;
    },
    clearTimeout() {},
  });
  replaceGlobal('document', {
    createElement: () => frame,
    body: { appendChild() { downloadFrameInserted = true; } },
  });

  return {
    workerMessages,
    get attachmentPort() { return attachmentPort; },
    get attachmentTimeout() { return attachmentTimeout; },
    get anchorClicked() { return downloadFrameInserted; },
    restore() {
      attachmentPort?.close();
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

test('browser download waits until the Service Worker attaches the download response', async () => {
  const browser = installBrowserMock();
  try {
    let resolved = false;
    const sessionPromise = createBrowserDownloadSession({ filename: 'video.ts', mimeType: 'video/mp2t' })
      .then((session) => {
        resolved = true;
        return session;
      });

    await waitFor(() => browser.attachmentPort);
    await waitFor(() => browser.anchorClicked ? true : undefined);
    assert.equal(resolved, false);

    browser.attachmentPort?.postMessage({ type: 'attached' });
    const session = await sessionPromise;
    await session.abort();
    assert.deepEqual(browser.workerMessages.map((message) => message.type), [
      'kvideo-download-probe',
      'kvideo-download-create',
      'kvideo-download-abort',
    ]);
  } finally {
    browser.restore();
  }
});

test('browser download stops when the download response never attaches', async () => {
  const browser = installBrowserMock();
  try {
    const sessionPromise = createBrowserDownloadSession({ filename: 'video.ts', mimeType: 'video/mp2t' });
    const timeout = await waitFor(() => browser.attachmentTimeout);
    timeout();

    await assert.rejects(sessionPromise, /下载栏未连接到下载流/);
    assert.deepEqual(browser.workerMessages.map((message) => message.type), [
      'kvideo-download-probe',
      'kvideo-download-create',
      'kvideo-download-abort',
    ]);
  } finally {
    browser.restore();
  }
});

test('browser download upgrades an incompatible Service Worker before creating the download stream', async () => {
  const browser = installBrowserMock({ startWithLegacyWorker: true });
  try {
    const sessionPromise = createBrowserDownloadSession({ filename: 'video.ts', mimeType: 'video/mp2t' });

    await waitFor(() => browser.attachmentPort);
    browser.attachmentPort?.postMessage({ type: 'attached' });
    const session = await sessionPromise;
    await session.abort();

    assert.deepEqual(browser.workerMessages.map((message) => message.type), [
      'kvideo-download-probe',
      'kvideo-download-probe',
      'kvideo-download-create',
      'kvideo-download-abort',
    ]);
  } finally {
    browser.restore();
  }
});
