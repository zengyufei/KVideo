'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Copy, Download, Link2, LoaderCircle, X } from 'lucide-react';
import { useMediaDownload, type MediaDownloadState } from './hooks/useMediaDownload';
import {
  createPlaybackLinkItems,
  type PlaybackLinkEpisode,
  type PlaybackLinkItem,
} from '@/lib/player/playback-links';

interface PlaybackLinksModalProps {
  isOpen: boolean;
  episodes: PlaybackLinkEpisode[] | null;
  currentEpisode: number;
  onClose: () => void;
}

function getPlaybackLinkKey(index: number, url: string): string {
  return `${index}:${url}`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unit;
  return `${value >= 100 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function formatDownloadStatus(state: MediaDownloadState): string | null {
  switch (state.phase) {
    case 'preparing':
      return '正在准备下载流';
    case 'completed':
      return '下载流已完成，浏览器正在保存文件';
    case 'handed-off':
      return '已交给浏览器原始下载';
    case 'cancelled':
      return '下载已取消';
    case 'failed':
      return state.error ? `下载失败：${state.error}` : '下载失败，请重试';
    default:
      return null;
  }
}

interface LinkDownloadControlsProps {
  item: PlaybackLinkItem;
  isCopied: boolean;
  onCopy: (index: number, url: string) => void;
  downloadState: MediaDownloadState;
  onStartDownload: (item: PlaybackLinkItem) => void;
  onCancelDownload: (item: PlaybackLinkItem) => void;
  withCopyLabel?: boolean;
}

function LinkDownloadControls({
  item,
  isCopied,
  onCopy,
  downloadState,
  onStartDownload,
  onCancelDownload,
  withCopyLabel = false,
}: LinkDownloadControlsProps) {
  const isDownloading = downloadState.phase === 'preparing' || downloadState.phase === 'downloading';

  return (
    <>
      <button
        type="button"
        onClick={() => onCopy(item.index, item.url)}
        className={`inline-flex shrink-0 items-center justify-center gap-1 border border-[var(--glass-border)] text-[var(--text-color-secondary)] transition-colors hover:bg-[var(--glass-hover)] hover:text-[var(--text-color)] cursor-pointer ${withCopyLabel ? 'h-9 px-2 text-xs font-medium' : 'h-8 w-8'}`}
        aria-label={`复制${item.name}链接`}
        title={isCopied ? '已复制' : '复制链接'}
      >
        {isCopied ? <Check size={15} /> : <Copy size={15} />}
        {withCopyLabel && <span>{isCopied ? '已复制' : '复制'}</span>}
      </button>
      {isDownloading ? (
        <button
          type="button"
          onClick={() => onCancelDownload(item)}
          className={`inline-flex shrink-0 items-center justify-center gap-1 border border-red-500/50 text-red-500 transition-colors hover:bg-red-500/10 cursor-pointer ${withCopyLabel ? 'h-9 px-2 text-xs font-medium' : 'h-8 w-8'}`}
          aria-label={`取消${item.name}下载`}
          title="取消下载"
        >
          <X size={15} />
          {withCopyLabel && <span>取消</span>}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => onStartDownload(item)}
          className={`inline-flex shrink-0 items-center justify-center gap-1 border border-[var(--glass-border)] text-[var(--text-color-secondary)] transition-colors hover:bg-[var(--glass-hover)] hover:text-[var(--text-color)] cursor-pointer ${withCopyLabel ? 'h-9 px-2 text-xs font-medium' : 'h-8 w-8'}`}
          aria-label={`下载${item.name}`}
          title={downloadState.phase === 'idle' ? '下载' : '重新下载'}
        >
          <Download size={15} />
          {withCopyLabel && <span>{downloadState.phase === 'idle' ? '下载' : '重新下载'}</span>}
        </button>
      )}
    </>
  );
}

function DownloadStatus({ state }: { state: MediaDownloadState }) {
  if (state.phase === 'downloading' && state.progress) {
    const { completedChunks, totalChunks, downloadedBytes, bytesPerSecond } = state.progress;
    const percentage = totalChunks > 0 ? Math.min((completedChunks / totalChunks) * 100, 100) : 0;

    return (
      <div className="mt-2" aria-live="polite">
        <div className="flex items-center gap-1.5 text-xs text-[var(--text-color-secondary)]">
          <LoaderCircle size={14} className="animate-spin" />
          <span>下载中 {completedChunks}/{totalChunks} 个分片</span>
          <span aria-hidden="true">·</span>
          <span>{formatBytes(downloadedBytes)}</span>
          <span aria-hidden="true">·</span>
          <span>{formatBytes(bytesPerSecond)}/s</span>
        </div>
        <div
          className="mt-1.5 h-1.5 overflow-hidden bg-black/10"
          role="progressbar"
          aria-label="下载进度"
          aria-valuemin={0}
          aria-valuemax={totalChunks}
          aria-valuenow={completedChunks}
          aria-valuetext={`${percentage.toFixed(0)}%`}
        >
          <div className="h-full bg-[var(--accent-color)] transition-[width]" style={{ width: `${percentage}%` }} />
        </div>
      </div>
    );
  }

  const status = formatDownloadStatus(state);
  if (!status) return null;

  return (
    <p
      role={state.phase === 'failed' ? 'alert' : undefined}
      className={`mt-2 text-xs ${state.phase === 'failed' ? 'text-red-500' : 'text-[var(--text-color-secondary)]'}`}
    >
      {status}
    </p>
  );
}

export function PlaybackLinksModal({
  isOpen,
  episodes,
  currentEpisode,
  onClose,
}: PlaybackLinksModalProps) {
  const [copiedLinkKey, setCopiedLinkKey] = useState<string | null>(null);
  const [copyErrorLinkKey, setCopyErrorLinkKey] = useState<string | null>(null);
  const { getDownloadState, startDownload, cancelDownload } = useMediaDownload();
  const items = useMemo(
    () => createPlaybackLinkItems(episodes, currentEpisode),
    [episodes, currentEpisode]
  );
  const currentItem = items.find((item) => item.isCurrent) ?? items[0];

  const closeModal = useCallback(() => {
    setCopiedLinkKey(null);
    setCopyErrorLinkKey(null);
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeModal();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, closeModal]);

  const handleCopy = useCallback(async (index: number, url: string) => {
    const linkKey = getPlaybackLinkKey(index, url);
    try {
      await navigator.clipboard.writeText(url);
      setCopiedLinkKey(linkKey);
      setCopyErrorLinkKey(null);
      window.setTimeout(() => {
        setCopiedLinkKey((current) => current === linkKey ? null : current);
      }, 1800);
    } catch {
      setCopyErrorLinkKey(linkKey);
    }
  }, []);

  if (!isOpen || !currentItem) return null;

  const linkType = (isM3u8: boolean) => isM3u8 ? 'M3U8 链接' : '播放链接';
  const currentLinkKey = getPlaybackLinkKey(currentItem.index, currentItem.url);
  const hasCopyError = copyErrorLinkKey !== null && items.some(
    (item) => getPlaybackLinkKey(item.index, item.url) === copyErrorLinkKey
  );

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4" role="presentation">
      <button
        type="button"
        className="absolute inset-0 bg-black/50 backdrop-blur-sm cursor-default"
        onClick={closeModal}
        aria-label="关闭播放链接面板"
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="playback-links-title"
        className="relative z-10 flex w-full max-w-3xl max-h-[min(760px,calc(100vh-2rem))] flex-col overflow-hidden rounded-lg border border-[var(--glass-border)] bg-[var(--bg-color)] shadow-[var(--shadow-md)]"
      >
        <header className="flex items-center justify-between gap-4 border-b border-[var(--glass-border)] px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <h2 id="playback-links-title" className="flex items-center gap-2 text-base font-semibold text-[var(--text-color)] sm:text-lg">
              <Link2 size={18} />
              获取播放链接
            </h2>
            <p className="mt-1 text-xs text-[var(--text-color-secondary)]">当前线路，共 {items.length} 集</p>
          </div>
          <button
            type="button"
            onClick={closeModal}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[var(--glass-border)] text-[var(--text-color-secondary)] transition-colors hover:bg-[var(--glass-hover)] hover:text-[var(--text-color)] cursor-pointer"
            aria-label="关闭"
            title="关闭"
          >
            <X size={18} />
          </button>
        </header>

        <div className="min-h-0 overflow-y-auto p-4 sm:p-5">
          <section className="border border-[var(--accent-color)] bg-[color-mix(in_srgb,var(--accent-color)_8%,transparent)] p-3 sm:p-4" aria-label="当前播放集链接">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs text-[var(--accent-color)]">当前播放</p>
                <h3 className="mt-1 truncate text-sm font-semibold text-[var(--text-color)] sm:text-base">{currentItem.name}</h3>
              </div>
              <span className="shrink-0 border border-[var(--glass-border)] px-2 py-1 text-xs text-[var(--text-color-secondary)]">
                {linkType(currentItem.isM3u8)}
              </span>
            </div>
            <div className="mt-3 flex items-start gap-2">
              <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap bg-black/10 px-3 py-2 text-xs text-[var(--text-color)] select-all">
                {currentItem.url}
              </code>
              <LinkDownloadControls
                item={currentItem}
                isCopied={copiedLinkKey === currentLinkKey}
                onCopy={handleCopy}
                downloadState={getDownloadState(currentItem)}
                onStartDownload={startDownload}
                onCancelDownload={cancelDownload}
                withCopyLabel
              />
            </div>
            <DownloadStatus state={getDownloadState(currentItem)} />
          </section>

          {hasCopyError && (
            <p role="alert" className="mt-3 text-sm text-red-500">复制失败，请检查浏览器剪贴板权限</p>
          )}

          <section className="mt-5" aria-labelledby="all-playback-links-title">
            <h3 id="all-playback-links-title" className="text-sm font-semibold text-[var(--text-color)]">全部集数</h3>
            <div className="mt-3 space-y-2">
              {items.map((item) => (
                <div
                  key={item.index}
                  className={`border p-3 ${item.isCurrent
                    ? 'border-[var(--accent-color)] bg-[color-mix(in_srgb,var(--accent-color)_5%,transparent)]'
                    : 'border-[var(--glass-border)] bg-[var(--glass-bg)]'
                    }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate text-sm font-medium text-[var(--text-color)]">{item.name}</span>
                    <span className="shrink-0 text-xs text-[var(--text-color-secondary)]">{linkType(item.isM3u8)}</span>
                  </div>
                  <div className="mt-2 flex items-start gap-2">
                    <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap bg-black/10 px-2 py-1.5 text-xs text-[var(--text-color)] select-all">
                      {item.url}
                    </code>
                    <LinkDownloadControls
                      item={item}
                      isCopied={copiedLinkKey === getPlaybackLinkKey(item.index, item.url)}
                      onCopy={handleCopy}
                      downloadState={getDownloadState(item)}
                      onStartDownload={startDownload}
                      onCancelDownload={cancelDownload}
                    />
                  </div>
                  <DownloadStatus state={getDownloadState(item)} />
                </div>
              ))}
            </div>
          </section>
        </div>
      </section>
    </div>
  );
}
