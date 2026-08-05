import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeAes128Iv,
  HlsDownloadError,
  parseHlsMediaPlaylist,
  processHlsChunks,
  resolveHlsDownloadPlan,
} from '@/lib/player/hls-download';
import { fetchHlsMediaResponse, readResponseBytes, streamResponseToDownload } from '@/lib/player/hls-download-client';

test('resolveHlsDownloadPlan selects the highest bandwidth variant and preserves segment order', async () => {
  const manifests: Record<string, string> = {
    'https://media.example.com/master.m3u8': `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=400000
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2400000
high/index.m3u8`,
    'https://media.example.com/high/index.m3u8': `#EXTM3U
#EXTINF:4,
one.ts
#EXTINF:4,
two.ts
#EXT-X-ENDLIST`,
  };

  const plan = await resolveHlsDownloadPlan(
    'https://media.example.com/master.m3u8',
    async (url) => manifests[url]
  );

  assert.equal(plan.playlistUrl, 'https://media.example.com/high/index.m3u8');
  assert.equal(plan.extension, 'ts');
  assert.deepEqual(plan.chunks.map((chunk) => chunk.url), [
    'https://media.example.com/high/one.ts',
    'https://media.example.com/high/two.ts',
  ]);
});

test('parseHlsMediaPlaylist creates one fMP4 file plan with init data and byte ranges', () => {
  const plan = parseHlsMediaPlaylist(`#EXTM3U
#EXT-X-MAP:URI="init.mp4",BYTERANGE="100@0"
#EXTINF:4,
#EXT-X-BYTERANGE:1000@200
parts.m4s
#EXTINF:4,
#EXT-X-BYTERANGE:1000
parts.m4s
#EXT-X-ENDLIST`, 'https://media.example.com/video/index.m3u8');

  assert.equal(plan.extension, 'mp4');
  assert.deepEqual(plan.chunks.map((chunk) => [chunk.kind, chunk.byteRange]), [
    ['init', { start: 0, end: 99 }],
    ['segment', { start: 200, end: 1199 }],
    ['segment', { start: 1200, end: 2199 }],
  ]);
});

test('HLS download parser rejects live and DRM playlists', () => {
  assert.throws(
    () => parseHlsMediaPlaylist('#EXTM3U\n#EXTINF:4,\nsegment.ts', 'https://media.example.com/live.m3u8'),
    HlsDownloadError
  );
  assert.throws(
    () => parseHlsMediaPlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"\n#EXTINF:4,\nsegment.ts\n#EXT-X-ENDLIST', 'https://media.example.com/drm.m3u8'),
    HlsDownloadError
  );
  assert.throws(
    () => parseHlsMediaPlaylist('#EXTM3U\n#EXT-X-PART:DURATION=0.5,URI="part.ts"\n#EXTINF:4,\nsegment.ts\n#EXT-X-ENDLIST', 'https://media.example.com/low-latency.m3u8'),
    HlsDownloadError
  );
});

test('AES-128 media sequence derives a 128-bit IV and chunks process in strict order', async () => {
  const iv = decodeAes128Iv(undefined, 258);
  assert.deepEqual([...iv.slice(0, 14)], new Array(14).fill(0));
  assert.deepEqual([...iv.slice(14)], [1, 2]);

  const plan = parseHlsMediaPlaylist(`#EXTM3U
#EXT-X-MEDIA-SEQUENCE:258
#EXT-X-KEY:METHOD=AES-128,URI="key.bin"
#EXTINF:4,
one.ts
#EXTINF:4,
two.ts
#EXT-X-ENDLIST`, 'https://media.example.com/vod/index.m3u8');
  const processed: string[] = [];

  await processHlsChunks(plan.chunks, async (chunk) => {
    processed.push(chunk.url);
  });

  assert.deepEqual(processed, [
    'https://media.example.com/vod/one.ts',
    'https://media.example.com/vod/two.ts',
  ]);
  assert.equal(plan.chunks[0].key?.uri, 'https://media.example.com/vod/key.bin');
  assert.equal(plan.chunks[0].sequence, 258);
  assert.equal(plan.chunks[1].sequence, 259);

  const explicitIv = parseHlsMediaPlaylist(`#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x00000000000000000000000000000001
#EXTINF:4,
one.ts
#EXT-X-ENDLIST`, 'https://media.example.com/vod/index.m3u8');
  assert.equal(explicitIv.chunks[0].key?.ivHex, '00000000000000000000000000000001');
});

test('processHlsChunks stops after the first failed segment and respects cancellation', async () => {
  const plan = parseHlsMediaPlaylist(`#EXTM3U
#EXTINF:4,
one.ts
#EXTINF:4,
two.ts
#EXT-X-ENDLIST`, 'https://media.example.com/vod/index.m3u8');
  const processed: number[] = [];

  await assert.rejects(
    processHlsChunks(plan.chunks, async (_chunk, index) => {
      processed.push(index);
      if (index === 0) throw new Error('network failed');
    }),
    /network failed/
  );
  assert.deepEqual(processed, [0]);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    processHlsChunks(plan.chunks, async () => undefined, controller.signal),
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError'
  );
});

test('streamResponseToDownload writes unencrypted media incrementally without collecting a file blob', async () => {
  const chunks = [new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5])];
  let nextChunk = 0;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[nextChunk];
      nextChunk += 1;
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  }));
  const written: Uint8Array[] = [];
  let downloadedBytes = 0;

  await streamResponseToDownload(
    response,
    async (chunk) => { written.push(chunk); },
    (count) => { downloadedBytes += count; }
  );

  assert.deepEqual(written.map((chunk) => [...chunk]), [[1, 2], [3], [4, 5]]);
  assert.equal(downloadedBytes, 5);
});

test('fetchHlsMediaResponse passes cancellation through to the current segment request', async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  globalThis.fetch = (_input, init) => new Promise((_resolve, reject) => {
    receivedSignal = init?.signal ?? undefined;
    receivedSignal?.addEventListener('abort', () => {
      reject(new DOMException('下载已取消', 'AbortError'));
    }, { once: true });
  });

  try {
    const request = fetchHlsMediaResponse('https://media.example.com/segment.ts', undefined, controller.signal);
    controller.abort();
    await assert.rejects(request, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
    assert.equal(receivedSignal, controller.signal);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('byte-range segments stream the requested bytes when an upstream ignores Range and returns 200', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([0, 1, 2, 3]));
      controller.enqueue(new Uint8Array([4, 5, 6, 7]));
      controller.close();
    },
  }), { status: 200 });

  try {
    const response = await fetchHlsMediaResponse(
      'https://media.example.com/segments.mp4',
      { start: 2, end: 5 },
      new AbortController().signal
    );
    const written: Uint8Array[] = [];

    await streamResponseToDownload(
      response,
      async (chunk) => { written.push(chunk); },
      () => undefined,
      { start: 2, end: 5 }
    );

    assert.deepEqual(written.map((chunk) => [...chunk]), [[2, 3], [4, 5]]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('encrypted byte-range segments keep only the requested bytes when an upstream returns 200', async () => {
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([0, 1, 2, 3]));
      controller.enqueue(new Uint8Array([4, 5, 6, 7]));
      controller.close();
    },
  }), { status: 200 });
  let downloadedBytes = 0;

  const encrypted = await readResponseBytes(
    response,
    (count) => { downloadedBytes += count; },
    { start: 2, end: 5 }
  );

  assert.deepEqual([...encrypted], [2, 3, 4, 5]);
  assert.equal(downloadedBytes, 4);
});
