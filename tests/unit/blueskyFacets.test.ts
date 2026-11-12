import { describe, expect, it } from 'vitest';
import {
  countGraphemes,
  detectBlueskyFacets,
  formatBlueskyPost,
  BlueskyGraphemeLimitError,
} from '@digitalcanopy/syndication-core';

describe('blueskyFacets', () => {
  it('correctly counts multi-byte emojis as single graphemes', () => {
    // 👩‍💻 is multiple code points (woman + ZWJ + laptop) but 1 grapheme cluster
    const emojiStr = '🚀 🔥 👩‍💻';
    expect(countGraphemes(emojiStr)).toBe(5); // 3 emojis + 2 spaces
  });

  it('computes exact UTF-8 byte offsets when multi-byte emojis precede a link', () => {
    // '🚀 Launch: ' -> '🚀' is 4 bytes in UTF-8, space is 1, 'Launch: ' is 8 -> total 13 bytes
    const text = '🚀 Launch: https://publish-stag.sunshade.icu/announcement';
    const facets = detectBlueskyFacets(text);

    expect(facets).toHaveLength(1);
    const linkFacet = facets[0]!;
    expect(linkFacet.features[0]?.$type).toBe('app.bsky.richtext.facet#link');

    const encoder = new TextEncoder();
    const encodedFull = encoder.encode(text);
    const linkSlice = encodedFull.slice(linkFacet.index.byteStart, linkFacet.index.byteEnd);
    const decodedUrl = new TextDecoder().decode(linkSlice);

    expect(decodedUrl).toBe('https://publish-stag.sunshade.icu/announcement');
    expect(linkFacet.index.byteStart).toBe(13);
  });

  it('detects mentions and tags with exact UTF-8 byte spans', () => {
    const text = 'Check @sunshade.bsky.social for #EdgePublishing updates!';
    const facets = detectBlueskyFacets(text, {
      'sunshade.bsky.social': 'did:plc:sunshade123456',
    });

    expect(facets).toHaveLength(2);

    const mentionFacet = facets[0]!;
    expect(mentionFacet.features[0]).toEqual({
      $type: 'app.bsky.richtext.facet#mention',
      did: 'did:plc:sunshade123456',
    });

    const tagFacet = facets[1]!;
    expect(tagFacet.features[0]).toEqual({
      $type: 'app.bsky.richtext.facet#tag',
      tag: 'EdgePublishing',
    });

    const encoder = new TextEncoder();
    const encoded = encoder.encode(text);

    const mentionBytes = encoded.slice(mentionFacet.index.byteStart, mentionFacet.index.byteEnd);
    expect(new TextDecoder().decode(mentionBytes)).toBe('@sunshade.bsky.social');

    const tagBytes = encoded.slice(tagFacet.index.byteStart, tagFacet.index.byteEnd);
    expect(new TextDecoder().decode(tagBytes)).toBe('#EdgePublishing');
  });

  it('enforces strict <= 300 grapheme limit and throws BlueskyGraphemeLimitError when exceeded', () => {
    const validPost = 'A'.repeat(300);
    expect(() => formatBlueskyPost(validPost)).not.toThrow();

    const oversizedPost = 'A'.repeat(301);
    expect(() => formatBlueskyPost(oversizedPost)).toThrow(BlueskyGraphemeLimitError);
  });
});
