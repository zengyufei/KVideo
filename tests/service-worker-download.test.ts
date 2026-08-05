import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

type Listener = (event: {
  data?: Record<string, unknown>;
  ports?: Array<{ postMessage(message: unknown): void }>;
  waitUntil(promise: Promise<unknown>): void;
}) => void;

function loadServiceWorker(): Map<string, Listener> {
  const listeners = new Map<string, Listener>();
  const serviceWorker = {
    location: { origin: 'https://kvideo.example.com' },
    skipWaiting() {},
    clients: { claim: async () => undefined },
    addEventListener(type: string, listener: Listener) {
      listeners.set(type, listener);
    },
  };
  const source = readFileSync(join(process.cwd(), 'public', 'sw.js'), 'utf8');
  const execute = new Function('self', 'caches', 'Response', 'URL', source);

  execute(serviceWorker, { keys: async () => [] }, Response, URL);
  return listeners;
}

test('download stream creation keeps the Service Worker alive until the stream is finished', async () => {
  const message = loadServiceWorker().get('message');
  assert.ok(message);

  const replies: unknown[] = [];
  const lifetimePromises: Promise<unknown>[] = [];
  message({
    data: {
      type: 'kvideo-download-create',
      id: 'download-1',
      filename: 'video.ts',
      mimeType: 'video/mp2t',
      stream: { getReader() {} },
    },
    ports: [{ postMessage: (reply) => replies.push(reply) }],
    waitUntil: (promise) => lifetimePromises.push(promise),
  });

  assert.deepEqual(replies, [{ type: 'ready' }]);
  assert.equal(lifetimePromises.length, 1);

  let settled = false;
  void lifetimePromises[0].then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);

  message({
    data: { type: 'kvideo-download-close', id: 'download-1' },
    waitUntil: () => undefined,
  });
  await lifetimePromises[0];
  assert.equal(settled, true);
});
