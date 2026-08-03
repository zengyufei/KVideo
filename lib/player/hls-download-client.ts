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
  if (byteRange && response.status !== 206) {
    throw new HlsDownloadError('上游不支持 HLS 所需的字节范围请求，无法下载');
  }
  return response;
}

async function readResponseBytes(response: Response, onBytes: (count: number) => void): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    onBytes(bytes.byteLength);
    return bytes;
  }

  const parts: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      parts.push(value);
      totalBytes += value.byteLength;
      onBytes(value.byteLength);
    }
  } finally {
    reader.releaseLock();
  }

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
  onBytes: (count: number) => void
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    await write(bytes);
    onBytes(bytes.byteLength);
    return;
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      await write(value);
      onBytes(value.byteLength);
    }
  } finally {
    reader.releaseLock();
  }
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
        const encrypted = await readResponseBytes(response, recordBytes);
        const decrypted = await decryptChunk(encrypted, chunk.key, chunk.sequence, keyCache, signal);
        await session.write(decrypted);
      } else {
        await streamResponseToDownload(response, session.write, recordBytes);
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
