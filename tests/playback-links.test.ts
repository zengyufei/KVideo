import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPlaybackLinkItems,
  isM3u8PlaybackUrl,
} from '@/lib/player/playback-links';

test('isM3u8PlaybackUrl recognizes M3U and M3U8 paths with query strings', () => {
  assert.equal(isM3u8PlaybackUrl('https://media.example.com/master.m3u8'), true);
  assert.equal(isM3u8PlaybackUrl('https://media.example.com/master.m3u8?token=abc'), true);
  assert.equal(isM3u8PlaybackUrl('https://media.example.com/live.m3u#section'), true);
  assert.equal(isM3u8PlaybackUrl('https://media.example.com/movie.mp4'), false);
  assert.equal(isM3u8PlaybackUrl('not a valid url'), false);
});

test('createPlaybackLinkItems preserves source order and identifies the current episode', () => {
  const items = createPlaybackLinkItems([
    { name: '第 1 集', url: 'https://media.example.com/one.m3u8' },
    { name: '第 2 集', url: 'https://media.example.com/two.mp4' },
    { url: 'https://media.example.com/three.m3u' },
  ], 1);

  assert.deepEqual(items.map((item) => item.name), ['第 1 集', '第 2 集', '第 3 集']);
  assert.deepEqual(items.map((item) => item.url), [
    'https://media.example.com/one.m3u8',
    'https://media.example.com/two.mp4',
    'https://media.example.com/three.m3u',
  ]);
  assert.deepEqual(items.map((item) => item.isM3u8), [true, false, true]);
  assert.deepEqual(items.map((item) => item.isCurrent), [false, true, false]);
});
