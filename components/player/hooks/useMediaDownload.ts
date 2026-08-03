'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createDownloadFilename,
  getUrlFileExtension,
  startDirectBrowserDownload,
} from '@/lib/player/browser-download';
import { downloadHlsMedia, type HlsDownloadProgress } from '@/lib/player/hls-download-client';
import type { PlaybackLinkItem } from '@/lib/player/playback-links';

export type MediaDownloadPhase = 'idle' | 'preparing' | 'downloading' | 'completed' | 'handed-off' | 'cancelled' | 'failed';

export interface MediaDownloadState {
  phase: MediaDownloadPhase;
  progress?: HlsDownloadProgress;
  error?: string;
}

function getDownloadKey(item: PlaybackLinkItem): string {
  return `${item.index}:${item.url}`;
}

function toDownloadErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return '下载已取消';
  }
  if (error instanceof Error) return error.message;
  return '下载失败，请重试';
}

export function useMediaDownload() {
  const [downloads, setDownloads] = useState<Record<string, MediaDownloadState>>({});
  const controllersRef = useRef(new Map<string, AbortController>());

  useEffect(() => () => {
    controllersRef.current.forEach((controller) => controller.abort());
    controllersRef.current.clear();
  }, []);

  const startDownload = useCallback((item: PlaybackLinkItem) => {
    const key = getDownloadKey(item);
    if (controllersRef.current.has(key)) return;

    if (!item.isM3u8) {
      const extension = getUrlFileExtension(item.url);
      startDirectBrowserDownload(item.url, createDownloadFilename(item.name, extension));
      setDownloads((current) => ({
        ...current,
        [key]: { phase: 'handed-off' },
      }));
      return;
    }

    const controller = new AbortController();
    controllersRef.current.set(key, controller);
    setDownloads((current) => ({ ...current, [key]: { phase: 'preparing' } }));

    void downloadHlsMedia({
      url: item.url,
      name: item.name,
      signal: controller.signal,
      onProgress: (progress) => {
        setDownloads((current) => ({
          ...current,
          [key]: { phase: 'downloading', progress },
        }));
      },
    }).then(() => {
      setDownloads((current) => ({ ...current, [key]: { phase: 'completed' } }));
    }).catch((error) => {
      const message = toDownloadErrorMessage(error);
      setDownloads((current) => ({
        ...current,
        [key]: message === '下载已取消'
          ? { phase: 'cancelled' }
          : { phase: 'failed', error: message },
      }));
    }).finally(() => {
      controllersRef.current.delete(key);
    });
  }, []);

  const cancelDownload = useCallback((item: PlaybackLinkItem) => {
    controllersRef.current.get(getDownloadKey(item))?.abort();
  }, []);

  return {
    getDownloadState: (item: PlaybackLinkItem) => downloads[getDownloadKey(item)] || { phase: 'idle' as const },
    startDownload,
    cancelDownload,
  };
}
