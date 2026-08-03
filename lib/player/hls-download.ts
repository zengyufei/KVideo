export type HlsDownloadChunkKind = 'init' | 'segment';

export interface HlsByteRange {
  start: number;
  end: number;
}

export interface HlsAes128Key {
  uri: string;
  ivHex?: string;
}

export interface HlsDownloadChunk {
  kind: HlsDownloadChunkKind;
  url: string;
  byteRange?: HlsByteRange;
  key?: HlsAes128Key;
  sequence: number;
}

export interface HlsDownloadPlan {
  chunks: HlsDownloadChunk[];
  extension: 'mp4' | 'ts';
  mimeType: 'video/mp4' | 'video/mp2t';
  playlistUrl: string;
}

export type HlsManifestLoader = (url: string) => Promise<string>;

interface ParsedAttributeList {
  [name: string]: string | undefined;
}

interface PendingByteRange {
  length: number;
  offset?: number;
}

interface MapDescriptor {
  url: string;
  byteRange?: HlsByteRange;
  key?: HlsAes128Key;
  signature: string;
}

const UNSUPPORTED_MEDIA_TAGS = [
  '#EXT-X-I-FRAMES-ONLY',
  '#EXT-X-PART',
  '#EXT-X-PRELOAD-HINT',
  '#EXT-X-RENDITION-REPORT',
  '#EXT-X-SERVER-CONTROL',
  '#EXT-X-SKIP',
  '#EXT-X-DEFINE',
  '#EXT-X-GAP',
];

export class HlsDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HlsDownloadError';
  }
}

function parseAttributeList(value: string): ParsedAttributeList {
  const attributes: ParsedAttributeList = {};
  const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(value)) !== null) {
    const rawValue = match[2].trim();
    attributes[match[1]] = rawValue.startsWith('"') && rawValue.endsWith('"')
      ? rawValue.slice(1, -1)
      : rawValue;
  }

  return attributes;
}

function resolveUrl(value: string, baseUrl: string): string {
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    throw new HlsDownloadError('播放清单包含无效地址，无法下载');
  }
}

function parseByteRange(value: string | undefined): PendingByteRange | undefined {
  if (!value) return undefined;

  const match = value.match(/^(\d+)(?:@(\d+))?$/);
  if (!match) {
    throw new HlsDownloadError('播放清单包含无效字节范围');
  }

  const length = Number(match[1]);
  const offset = match[2] === undefined ? undefined : Number(match[2]);
  if (!Number.isSafeInteger(length) || length <= 0 || (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0))) {
    throw new HlsDownloadError('播放清单包含无效字节范围');
  }

  return { length, offset };
}

function resolveByteRange(
  pending: PendingByteRange | undefined,
  resourceUrl: string,
  previousEndByUrl: Map<string, number>
): HlsByteRange | undefined {
  if (!pending) return undefined;

  const start = pending.offset ?? previousEndByUrl.get(resourceUrl) ?? 0;
  const end = start + pending.length - 1;
  if (!Number.isSafeInteger(end) || end < start) {
    throw new HlsDownloadError('播放清单包含过大的字节范围');
  }

  previousEndByUrl.set(resourceUrl, end + 1);
  return { start, end };
}

function parseIvHex(value: string | undefined): string | undefined {
  if (!value) return undefined;

  const normalized = value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]{32}$/.test(normalized)) {
    throw new HlsDownloadError('AES-128 流的 IV 无效');
  }

  return normalized.toLowerCase();
}

function parseEncryptionKey(value: string, playlistUrl: string): HlsAes128Key | undefined {
  const attributes = parseAttributeList(value);
  const method = attributes.METHOD?.toUpperCase();

  if (method === 'NONE') return undefined;
  if (method !== 'AES-128') {
    throw new HlsDownloadError('该 HLS 流使用 DRM 或不支持的加密方式，无法下载');
  }

  if (attributes.KEYFORMAT && attributes.KEYFORMAT.toLowerCase() !== 'identity') {
    throw new HlsDownloadError('该 HLS 流使用 DRM 或不支持的密钥格式，无法下载');
  }

  if (!attributes.URI) {
    throw new HlsDownloadError('AES-128 流缺少密钥地址');
  }

  return {
    uri: resolveUrl(attributes.URI, playlistUrl),
    ivHex: parseIvHex(attributes.IV),
  };
}

function selectHighestBandwidthVariant(content: string, playlistUrl: string): string | null {
  const lines = content.split(/\r?\n/);
  const variants: Array<{ bandwidth: number; url: string }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;

    const attributes = parseAttributeList(line.slice('#EXT-X-STREAM-INF:'.length));
    const bandwidth = Number(attributes.BANDWIDTH ?? 0);
    let uri = '';

    for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
      const candidate = lines[nextIndex].trim();
      if (!candidate) continue;
      if (candidate.startsWith('#')) break;
      uri = candidate;
      break;
    }

    if (!uri) {
      throw new HlsDownloadError('主播放清单缺少视频变体地址');
    }

    variants.push({
      bandwidth: Number.isFinite(bandwidth) && bandwidth > 0 ? bandwidth : 0,
      url: resolveUrl(uri, playlistUrl),
    });
  }

  if (variants.length === 0) return null;
  variants.sort((left, right) => right.bandwidth - left.bandwidth);
  return variants[0].url;
}

function ensureSupportedMediaTags(lines: string[]): void {
  for (const line of lines) {
    const trimmed = line.trim();
    if (UNSUPPORTED_MEDIA_TAGS.some((tag) => trimmed.startsWith(tag))) {
      throw new HlsDownloadError('该 HLS 清单使用了当前下载器不支持的低延迟或帧级标签');
    }
  }
}

export function parseHlsMediaPlaylist(content: string, playlistUrl: string): HlsDownloadPlan {
  const lines = content.split(/\r?\n/);
  const normalizedContent = content.trim();
  if (!normalizedContent.startsWith('#EXTM3U')) {
    throw new HlsDownloadError('地址返回的不是有效 M3U8 播放清单');
  }

  ensureSupportedMediaTags(lines);

  if (lines.some((line) => line.trim().startsWith('#EXT-X-STREAM-INF:'))) {
    throw new HlsDownloadError('主播放清单必须先选择视频变体');
  }

  let hasEndList = false;
  let sequence = 0;
  let pendingByteRange: PendingByteRange | undefined;
  let currentKey: HlsAes128Key | undefined;
  let currentMap: MapDescriptor | undefined;
  let writtenMapSignature: string | undefined;
  const previousEndByUrl = new Map<string, number>();
  const chunks: HlsDownloadChunk[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line === '#EXT-X-ENDLIST') {
      hasEndList = true;
      continue;
    }

    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      const parsedSequence = Number(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length));
      if (!Number.isSafeInteger(parsedSequence) || parsedSequence < 0) {
        throw new HlsDownloadError('播放清单包含无效媒体序号');
      }
      sequence = parsedSequence;
      continue;
    }

    if (line.startsWith('#EXT-X-KEY:')) {
      currentKey = parseEncryptionKey(line.slice('#EXT-X-KEY:'.length), playlistUrl);
      continue;
    }

    if (line.startsWith('#EXT-X-SESSION-KEY:')) {
      parseEncryptionKey(line.slice('#EXT-X-SESSION-KEY:'.length), playlistUrl);
      continue;
    }

    if (line.startsWith('#EXT-X-MAP:')) {
      const attributes = parseAttributeList(line.slice('#EXT-X-MAP:'.length));
      if (!attributes.URI) {
        throw new HlsDownloadError('fMP4 播放清单缺少初始化片段');
      }
      if (currentKey && !currentKey.ivHex) {
        throw new HlsDownloadError('加密 fMP4 初始化片段缺少 IV，无法下载');
      }

      const url = resolveUrl(attributes.URI, playlistUrl);
      const byteRange = resolveByteRange(parseByteRange(attributes.BYTERANGE), url, previousEndByUrl);
      currentMap = {
        url,
        byteRange,
        key: currentKey,
        signature: `${url}|${byteRange?.start ?? ''}|${byteRange?.end ?? ''}|${currentKey?.uri ?? ''}|${currentKey?.ivHex ?? ''}`,
      };
      continue;
    }

    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingByteRange = parseByteRange(line.slice('#EXT-X-BYTERANGE:'.length));
      continue;
    }

    if (line.startsWith('#')) continue;

    const url = resolveUrl(line, playlistUrl);
    const byteRange = resolveByteRange(pendingByteRange, url, previousEndByUrl);
    pendingByteRange = undefined;

    if (currentMap && writtenMapSignature !== currentMap.signature) {
      chunks.push({
        kind: 'init',
        url: currentMap.url,
        byteRange: currentMap.byteRange,
        key: currentMap.key,
        sequence,
      });
      writtenMapSignature = currentMap.signature;
    }

    chunks.push({
      kind: 'segment',
      url,
      byteRange,
      key: currentKey,
      sequence,
    });
    sequence += 1;
  }

  if (!hasEndList) {
    throw new HlsDownloadError('直播或未结束的 HLS 流不支持下载');
  }
  if (pendingByteRange) {
    throw new HlsDownloadError('播放清单中的字节范围缺少媒体分片');
  }
  if (chunks.every((chunk) => chunk.kind !== 'segment')) {
    throw new HlsDownloadError('播放清单没有可下载的视频分片');
  }

  const hasInitializationSegment = chunks.some((chunk) => chunk.kind === 'init');
  return {
    chunks,
    extension: hasInitializationSegment ? 'mp4' : 'ts',
    mimeType: hasInitializationSegment ? 'video/mp4' : 'video/mp2t',
    playlistUrl,
  };
}

export async function resolveHlsDownloadPlan(
  sourceUrl: string,
  loadManifest: HlsManifestLoader,
  maxDepth = 4
): Promise<HlsDownloadPlan> {
  let playlistUrl = sourceUrl;

  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const content = await loadManifest(playlistUrl);
    const variantUrl = selectHighestBandwidthVariant(content, playlistUrl);
    if (!variantUrl) {
      return parseHlsMediaPlaylist(content, playlistUrl);
    }
    playlistUrl = variantUrl;
  }

  throw new HlsDownloadError('主播放清单嵌套层级过深，无法下载');
}

export function decodeAes128Iv(ivHex: string | undefined, sequence: number): Uint8Array {
  if (ivHex) {
    const iv = new Uint8Array(16);
    for (let index = 0; index < iv.length; index += 1) {
      iv[index] = Number.parseInt(ivHex.slice(index * 2, index * 2 + 2), 16);
    }
    return iv;
  }

  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new HlsDownloadError('AES-128 流的媒体序号无效');
  }

  const iv = new Uint8Array(16);
  let value = sequence;
  for (let index = iv.length - 1; index >= 0; index -= 1) {
    iv[index] = value % 256;
    value = Math.floor(value / 256);
  }
  return iv;
}

export async function processHlsChunks(
  chunks: HlsDownloadChunk[],
  processChunk: (chunk: HlsDownloadChunk, index: number) => Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  for (let index = 0; index < chunks.length; index += 1) {
    if (signal?.aborted) {
      throw new DOMException('下载已取消', 'AbortError');
    }
    await processChunk(chunks[index], index);
  }
}
