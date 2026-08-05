'use client';

import {
  decodeAes128Iv,
  HlsDownloadError,
  processHlsChunks,
  resolveHlsDownloadPlan,
  type HlsAes128Key,
  type HlsByteRange,
  type HlsDownloadChunk,
} from './hls-download';
import { createBrowserDownloadSession, createDownloadFilename } from './browser-download';

export interface HlsDownloadProgress {
  completedChunks: number;
  totalChunks: number;
  downloadedBytes: number;
  bytesPerSecond: number;
}

export interface HlsDownloadOptions {
  url: string;
  name: string;
  signal: AbortSignal;
  onProgress(progress: HlsDownloadProgress): void;
}

function createFetchError(response: Response, resourceType: string): HlsDownloadError {
  return new HlsDownloadError(`${resourceType}请求失败：HTTP ${response.status}`);
}

async function fetchManifestText(url: string, signal: AbortSignal): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new HlsDownloadError('无法读取播放清单。上游必须允许浏览器跨域访问（CORS）');
  }

  if (!response.ok) throw createFetchError(response, '播放清单');
  return response.text();
}

export async function fetchHlsMediaResponse(
  url: string,
  byteRange: HlsByteRange | undefined,
  signal: AbortSignal
): Promise<Response> {
  const headers = byteRange ? { Range: `bytes=${byteRange.start}-${byteRange.end}` } : undefined;
  let response: Response;
  try {
    response = await fetch(url, { headers, signal });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new HlsDownloadError('无法读取视频分片。上游必须允许浏览器跨域访问（CORS）');
  }

  if (!response.ok) throw createFetchError(response, '视频分片');
  return response;
}

interface ByteRangeFilter {
  filter(chunk: Uint8Array): Uint8Array | undefined;
  isComplete(): boolean;
  assertComplete(): void;
}

function createByteRangeFilter(byteRange: HlsByteRange | undefined): ByteRangeFilter {
  if (!byteRange) {
    return {
      filter: (chunk) => chunk,
      isComplete: () => false,
      assertComplete() {},
    };
  }

  let sourceOffset = 0;
  let remainingBytes = byteRange.end - byteRange.start + 1;

  return {
    filter(chunk) {
      const chunkStart = sourceOffset;
      sourceOffset += chunk.byteLength;
      if (remainingBytes <= 0 || chunkStart + chunk.byteLength <= byteRange.start) return undefined;

      const start = Math.max(byteRange.start - chunkStart, 0);
      const end = Math.min(chunk.byteLength, start + remainingBytes);
      if (end <= start) return undefined;

      const requestedBytes = chunk.subarray(start, end);
      remainingBytes -= requestedBytes.byteLength;
      return requestedBytes;
    },
    isComplete: () => remainingBytes === 0,
    assertComplete() {
      if (remainingBytes > 0) {
        throw new HlsDownloadError('上游返回的分片小于清单声明的字节范围');
      }
    },
  };
}

export async function readResponseBytes(
  response: Response,
  onBytes: (count: number) => void,
  byteRange?: HlsByteRange
): Promise<Uint8Array> {
  const rangeFilter = createByteRangeFilter(response.status === 200 ? byteRange : undefined);
  const reader = response.body?.getReader();
  if (!reader) {
    const requestedBytes = rangeFilter.filter(new Uint8Array(await response.arrayBuffer()));
    rangeFilter.assertComplete();
    if (!requestedBytes) return new Uint8Array();
    onBytes(requestedBytes.byteLength);
    return requestedBytes;
  }

  const parts: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const requestedBytes = rangeFilter.filter(value);
      if (requestedBytes) {
        parts.push(requestedBytes);
        totalBytes += requestedBytes.byteLength;
        onBytes(requestedBytes.byteLength);
      }
      if (rangeFilter.isComplete()) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  rangeFilter.assertComplete();

  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

export async function streamResponseToDownload(
  response: Response,
  write: (chunk: Uint8Array) => Promise<void>,
  onBytes: (count: number) => void,
  byteRange?: HlsByteRange
): Promise<void> {
  const rangeFilter = createByteRangeFilter(response.status === 200 ? byteRange : undefined);

  const writeRequestedBytes = async (chunk: Uint8Array) => {
    const requestedBytes = rangeFilter.filter(chunk);
    if (!requestedBytes) return;
    await write(requestedBytes);
    onBytes(requestedBytes.byteLength);
  };

  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    await writeRequestedBytes(bytes);
    rangeFilter.assertComplete();
    return;
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      await writeRequestedBytes(value);
      if (rangeFilter.isComplete()) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  rangeFilter.assertComplete();
}

async function importAes128Key(key: HlsAes128Key, signal: AbortSignal): Promise<CryptoKey> {
  const response = await fetchHlsMediaResponse(key.uri, undefined, signal);
  const keyBytes = new Uint8Array(await response.arrayBuffer());
  if (keyBytes.byteLength !== 16) {
    throw new HlsDownloadError('AES-128 密钥长度无效');
  }
  if (!crypto.subtle) {
    throw new HlsDownloadError('当前浏览器不支持 AES-128 HLS 下载，请使用桌面 Chrome 或 Edge');
  }
  return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
}

function toCryptoBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function decryptChunk(
  data: Uint8Array,
  key: HlsAes128Key,
  sequence: number,
  keyCache: Map<string, Promise<CryptoKey>>,
  signal: AbortSignal
): Promise<Uint8Array> {
  const cacheKey = `${key.uri}|${key.ivHex ?? ''}`;
  let cryptoKey = keyCache.get(cacheKey);
  if (!cryptoKey) {
    cryptoKey = importAes128Key(key, signal);
    keyCache.set(cacheKey, cryptoKey);
  }

  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-CBC', iv: toCryptoBuffer(decodeAes128Iv(key.ivHex, sequence)) },
      await cryptoKey,
      toCryptoBuffer(data)
    );
    return new Uint8Array(decrypted);
  } catch {
    throw new HlsDownloadError('AES-128 分片解密失败');
  }
}

export async function downloadHlsMedia({
  url,
  name,
  signal,
  onProgress,
}: HlsDownloadOptions): Promise<void> {
  const plan = await resolveHlsDownloadPlan(url, (manifestUrl) => fetchManifestText(manifestUrl, signal));
  const session = await createBrowserDownloadSession({
    filename: createDownloadFilename(name, plan.extension),
    mimeType: plan.mimeType,
  });
  const abortDownload = () => {
    void session.abort(new DOMException('下载已取消', 'AbortError'));
  };
  if (signal.aborted) {
    abortDownload();
    throw new DOMException('下载已取消', 'AbortError');
  }
  signal.addEventListener('abort', abortDownload, { once: true });
  const keyCache = new Map<string, Promise<CryptoKey>>();
  const startedAt = performance.now();
  let lastProgressAt = startedAt;
  let downloadedBytes = 0;
  let completedChunks = 0;
  const totalChunks = plan.chunks.length;

  const reportProgress = (force = false) => {
    const now = performance.now();
    if (!force && now - lastProgressAt < 250) return;

    lastProgressAt = now;
    const elapsedSeconds = Math.max((now - startedAt) / 1000, 0.001);
    onProgress({
      completedChunks,
      totalChunks,
      downloadedBytes,
      bytesPerSecond: downloadedBytes / elapsedSeconds,
    });
  };

  const recordBytes = (count: number) => {
    downloadedBytes += count;
    reportProgress();
  };

  try {
    await processHlsChunks(plan.chunks, async (chunk: HlsDownloadChunk) => {
      const response = await fetchHlsMediaResponse(chunk.url, chunk.byteRange, signal);
      if (chunk.key) {
        const encrypted = await readResponseBytes(response, recordBytes, chunk.byteRange);
        const decrypted = await decryptChunk(encrypted, chunk.key, chunk.sequence, keyCache, signal);
        await session.write(decrypted);
      } else {
        await streamResponseToDownload(response, session.write, recordBytes, chunk.byteRange);
      }
      completedChunks += 1;
      reportProgress(true);
    }, signal);
    await session.close();
  } catch (error) {
    await session.abort(error);
    throw error;
  } finally {
    signal.removeEventListener('abort', abortDownload);
  }
}
