import { describe, expect, it } from 'vitest';
import { splitIntoXThread } from '@digitalcanopy/syndication-core';

describe('xThreader', () => {
  it('keeps short text under 280 characters in a single tweet chunk', () => {
    const text = 'Quick dispatch update from SunShade Systems engineering.';
    const result = splitIntoXThread(text, {
      shortUrl: 'https://links-stag.sunshade.icu/x1',
    });

    expect(result.chunks).toHaveLength(1);
    expect(result.anchorTweetText).toContain('https://links-stag.sunshade.icu/x1');
    expect(result.anchorEffectiveLength).toBeLessThanOrEqual(280);
  });

  it('reserves 24 characters on the anchor tweet so link attachment stays within 280 bounds', () => {
    // Generate text longer than 280 chars to trigger threading
    const sentence1 = 'A'.repeat(250) + '.';
    const sentence2 = 'B'.repeat(200) + '.';
    const combined = `${sentence1} ${sentence2}`;

    const result = splitIntoXThread(combined, {
      shortUrl: 'https://links-stag.sunshade.icu/abcdef',
    });

    expect(result.chunks.length).toBeGreaterThanOrEqual(2);
    // Anchor chunk must fit within 280 - 24 = 256 characters
    expect(result.chunks[0]!.length).toBeLessThanOrEqual(256);
    expect(result.anchorEffectiveLength).toBeLessThanOrEqual(280);
    // Subsequent chunks can use full 280 budget
    for (let i = 1; i < result.chunks.length; i += 1) {
      expect(result.chunks[i]!.length).toBeLessThanOrEqual(280);
    }
  });

  it('splits cleanly at sentence boundaries without breaking words apart unnecessarily', () => {
    const text =
      'First sentence introduces the new syndication worker. ' +
      'Second sentence elaborates on isolated Cloudflare Queue retries and multi-channel publishing. ' +
      'Third sentence concludes with open-source contributor instructions.';

    const result = splitIntoXThread(text, { maxChars: 100, linkReserveChars: 24 });
    expect(result.chunks.length).toBeGreaterThanOrEqual(2);

    for (const chunk of result.chunks) {
      expect(chunk.endsWith('.')).toBe(true);
    }
  });

  it('handles empty input gracefully', () => {
    const result = splitIntoXThread('');
    expect(result.chunks).toHaveLength(0);
    expect(result.totalTweets).toBe(0);
  });
});
