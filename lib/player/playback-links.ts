export interface PlaybackLinkEpisode {
  name?: string;
  url: string;
}

export interface PlaybackLinkItem {
  index: number;
  name: string;
  url: string;
  isM3u8: boolean;
  isCurrent: boolean;
}

export function isM3u8PlaybackUrl(url: string): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return pathname.endsWith('.m3u8') || pathname.endsWith('.m3u');
  } catch {
    const pathname = url.split(/[?#]/, 1)[0].toLowerCase();
    return pathname.endsWith('.m3u8') || pathname.endsWith('.m3u');
  }
}

export function createPlaybackLinkItems(
  episodes: PlaybackLinkEpisode[] | null | undefined,
  currentEpisode: number
): PlaybackLinkItem[] {
  return (episodes ?? []).map((episode, index) => ({
    index,
    name: episode.name || `第 ${index + 1} 集`,
    url: episode.url,
    isM3u8: isM3u8PlaybackUrl(episode.url),
    isCurrent: index === currentEpisode,
  }));
}
