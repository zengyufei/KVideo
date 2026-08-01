'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Copy, Link2, X } from 'lucide-react';
import { createPlaybackLinkItems, type PlaybackLinkEpisode } from '@/lib/player/playback-links';

interface PlaybackLinksModalProps {
  isOpen: boolean;
  episodes: PlaybackLinkEpisode[] | null;
  currentEpisode: number;
  onClose: () => void;
}

function getPlaybackLinkKey(index: number, url: string): string {
  return `${index}:${url}`;
}

export function PlaybackLinksModal({
  isOpen,
  episodes,
  currentEpisode,
  onClose,
}: PlaybackLinksModalProps) {
  const [copiedLinkKey, setCopiedLinkKey] = useState<string | null>(null);
  const [copyErrorLinkKey, setCopyErrorLinkKey] = useState<string | null>(null);
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
              <button
                type="button"
                onClick={() => handleCopy(currentItem.index, currentItem.url)}
                className="inline-flex h-9 shrink-0 items-center justify-center gap-1 border border-[var(--glass-border)] px-2 text-xs font-medium text-[var(--text-color)] transition-colors hover:bg-[var(--glass-hover)] cursor-pointer"
                aria-label={`复制${currentItem.name}链接`}
                title="复制链接"
              >
                {copiedLinkKey === currentLinkKey ? <Check size={15} /> : <Copy size={15} />}
                <span>{copiedLinkKey === currentLinkKey ? '已复制' : '复制'}</span>
              </button>
            </div>
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
                    <button
                      type="button"
                      onClick={() => handleCopy(item.index, item.url)}
                      className="flex h-8 w-8 shrink-0 items-center justify-center border border-[var(--glass-border)] text-[var(--text-color-secondary)] transition-colors hover:bg-[var(--glass-hover)] hover:text-[var(--text-color)] cursor-pointer"
                      aria-label={`复制${item.name}链接`}
                      title={copiedLinkKey === getPlaybackLinkKey(item.index, item.url) ? '已复制' : '复制链接'}
                    >
                      {copiedLinkKey === getPlaybackLinkKey(item.index, item.url) ? <Check size={15} /> : <Copy size={15} />}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </section>
    </div>
  );
}
