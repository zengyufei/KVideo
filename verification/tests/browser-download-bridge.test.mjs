import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const serviceWorker = await readFile(path.join(root, 'public/sw.js'), 'utf8');
const page = `<!doctype html>
<button id="download">Download</button>
<script>
  async function startDownload() {
    const worker = navigator.serviceWorker.controller;
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();
    const channel = new MessageChannel();
    const result = new Promise((resolve, reject) => {
      channel.port1.onmessage = async (event) => {
        if (event.data?.type === 'error' || event.data?.type === 'aborted') {
          reject(new Error(event.data.message || event.data.type));
          return;
        }
        if (event.data?.type !== 'attached') return;
        await writer.write(new Uint8Array([1, 2]));
        await writer.write(new Uint8Array([3]));
        await writer.write(new Uint8Array([4, 5]));
        await writer.close();
        worker.postMessage({ type: 'kvideo-download-close', id: 'bridge-download' });
        resolve();
      };
    });
    worker.postMessage({
      type: 'kvideo-download-create',
      id: 'bridge-download',
      filename: 'bridge.ts',
      mimeType: 'video/mp2t',
      stream: stream.readable,
    }, [stream.readable, channel.port2]);
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.src = '/__kvideo-download/bridge-download';
    document.body.appendChild(frame);
    await result;
    document.body.dataset.result = 'written';
  }
  document.querySelector('#download').addEventListener('click', () => {
    startDownload().catch((error) => { document.body.dataset.result = error.message; });
  });
</script>`;

function chromeExecutable() {
  const candidates = process.platform === 'win32'
    ? [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    ]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'];
  return candidates.find(existsSync);
}

function startServer() {
  const server = createServer((request, response) => {
    if (request.url === '/sw.js') {
      response.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
      response.end(serviceWorker);
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    response.end(page);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('Chrome downloads a Service Worker stream after three ordered writes', async () => {
  const executablePath = chromeExecutable();
  assert.ok(executablePath, 'Google Chrome or Chromium is required for the download bridge test');
  const server = await startServer();
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ executablePath, headless: true });

  try {
    const context = await browser.newContext({ acceptDownloads: true });
    const tab = await context.newPage();
    await tab.goto(origin);
    await tab.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.js');
      if (navigator.serviceWorker.controller) return;
      await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    });

    const downloadPromise = tab.waitForEvent('download');
    await tab.locator('#download').click();
    const download = await downloadPromise;
    await tab.waitForFunction(() => document.body.dataset.result, undefined, { timeout: 5000 });
    const result = await tab.evaluate(() => document.body.dataset.result);
    assert.equal(result, 'written');
    assert.equal(await download.failure(), null);
    const downloadPath = await download.path();
    assert.ok(downloadPath);
    assert.deepEqual([...await readFile(downloadPath)], [1, 2, 3, 4, 5]);
    await context.close();
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
