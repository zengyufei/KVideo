import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

type MessageListener = (event: {
  data?: Record<string, unknown>;
  ports?: Array<{ postMessage(message: unknown): void }>;
  waitUntil(promise: Promise<unknown>): void;
}) => void;

type FetchListener = (event: {
  request: Request;
  respondWith(response: Response | Promise<Response>): void;
  waitUntil(promise: Promise<unknown>): void;
}) => void;

function loadServiceWorker(): Map<string, MessageListener | FetchListener> {
  const listeners = new Map<string, MessageListener | FetchListener>();
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
  const listeners = loadServiceWorker();
  const message = listeners.get('message') as MessageListener | undefined;
  const fetch = listeners.get('fetch') as FetchListener | undefined;
  assert.ok(message);
  assert.ok(fetch);

  const replies: unknown[] = [];
  const lifetimePromises: Promise<unknown>[] = [];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
  message({
    data: {
      type: 'kvideo-download-create',
      id: 'download-1',
      filename: 'video.ts',
      mimeType: 'video/mp2t',
      stream,
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

  let response: Response | undefined;
  fetch({
    request: new Request('https://kvideo.example.com/__kvideo-download/download-1'),
    respondWith: (value) => { response = value as Response; },
    waitUntil: () => undefined,
  });
  await response?.arrayBuffer();
  await lifetimePromises[0];
  assert.equal(settled, true);
});

test('download response attaches before streaming and preserves every chunk in order', async () => {
  const listeners = loadServiceWorker();
  const message = listeners.get('message') as MessageListener | undefined;
  const fetch = listeners.get('fetch') as FetchListener | undefined;
  assert.ok(message);
  assert.ok(fetch);

  const replies: Array<{ type?: string }> = [];
  let sourceController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      sourceController = controller;
    },
  });
  const messageLifetime: Promise<unknown>[] = [];
  message({
    data: {
      type: 'kvideo-download-create',
      id: 'download-2',
      filename: 'video.ts',
      mimeType: 'video/mp2t',
      stream: source,
    },
    ports: [{ postMessage: (reply) => replies.push(reply as { type?: string }) }],
    waitUntil: (promise) => messageLifetime.push(promise),
  });

  let response: Response | undefined;
  const fetchLifetime: Promise<unknown>[] = [];
  fetch({
    request: new Request('https://kvideo.example.com/__kvideo-download/download-2'),
    respondWith: (value) => { response = value as Response; },
    waitUntil: (promise) => fetchLifetime.push(promise),
  });

  assert.deepEqual(replies.map((reply) => reply.type), ['ready', 'attached']);
  assert.ok(response);
  sourceController?.enqueue(new Uint8Array([1, 2]));
  sourceController?.enqueue(new Uint8Array([3]));
  sourceController?.enqueue(new Uint8Array([4, 5]));
  sourceController?.close();

  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3, 4, 5]);
  await Promise.all([...messageLifetime, ...fetchLifetime]);
  assert.deepEqual(replies.map((reply) => reply.type), ['ready', 'attached', 'streaming', 'closed']);
});

test('download stream reports a browser-side cancellation and missing streams return 404', async () => {
  const listeners = loadServiceWorker();
  const message = listeners.get('message') as MessageListener | undefined;
  const fetch = listeners.get('fetch') as FetchListener | undefined;
  assert.ok(message);
  assert.ok(fetch);

  const replies: Array<{ type?: string; message?: string }> = [];
  const source = new ReadableStream<Uint8Array>({});
  message({
    data: {
      type: 'kvideo-download-create',
      id: 'download-3',
      filename: 'video.ts',
      mimeType: 'video/mp2t',
      stream: source,
    },
    ports: [{ postMessage: (reply) => replies.push(reply as { type?: string; message?: string }) }],
    waitUntil: () => undefined,
  });

  let response: Response | undefined;
  fetch({
    request: new Request('https://kvideo.example.com/__kvideo-download/download-3'),
    respondWith: (value) => { response = value as Response; },
    waitUntil: () => undefined,
  });
  assert.ok(response);
  await response.body?.cancel();
  assert.equal(replies.at(-1)?.type, 'aborted');
  assert.match(replies.at(-1)?.message || '', /浏览器下载已取消/);

  let missingResponse: Response | undefined;
  fetch({
    request: new Request('https://kvideo.example.com/__kvideo-download/missing'),
    respondWith: (value) => { missingResponse = value as Response; },
    waitUntil: () => undefined,
  });
  assert.equal(missingResponse?.status, 404);
});
