export const BLUESKY_MAX_GRAPHEMES = 300;

export interface BlueskyByteSpan {
  byteStart: number;
  byteEnd: number;
}

export type BlueskyFacetFeature =
  | { $type: 'app.bsky.richtext.facet#link'; uri: string }
  | { $type: 'app.bsky.richtext.facet#mention'; did: string }
  | { $type: 'app.bsky.richtext.facet#tag'; tag: string };

export interface BlueskyFacet {
  index: BlueskyByteSpan;
  features: [BlueskyFacetFeature];
}

export interface BlueskyValidationResult {
  valid: boolean;
  graphemeCount: number;
  maxGraphemes: number;
}

export interface FormattedBlueskyPost {
  text: string;
  facets: BlueskyFacet[];
  graphemeCount: number;
}

export class BlueskyGraphemeLimitError extends Error {
  readonly graphemeCount: number;
  readonly maxGraphemes: number;

  constructor(graphemeCount: number, maxGraphemes = BLUESKY_MAX_GRAPHEMES) {
    super(`Bluesky post exceeds ${maxGraphemes} graphemes (got ${graphemeCount}).`);
    this.name = 'BlueskyGraphemeLimitError';
    this.graphemeCount = graphemeCount;
    this.maxGraphemes = maxGraphemes;
  }
}

const graphemeSegmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
const utf8Encoder = new TextEncoder();

/**
 * Counts Unicode grapheme clusters (matching AT Protocol's 300-grapheme limit).
 */
export function countGraphemes(text: string): number {
  let count = 0;
  for (const _segment of graphemeSegmenter.segment(text)) {
    count += 1;
  }
  return count;
}

/**
 * Validates that text fits within Bluesky's 300-grapheme budget.
 */
export function validateBlueskyText(
  text: string,
  maxGraphemes = BLUESKY_MAX_GRAPHEMES,
): BlueskyValidationResult {
  const graphemeCount = countGraphemes(text);
  return {
    valid: graphemeCount <= maxGraphemes,
    graphemeCount,
    maxGraphemes,
  };
}

function utf8ByteOffset(text: string, utf16Index: number): number {
  return utf8Encoder.encode(text.slice(0, utf16Index)).byteLength;
}

function trimTrailingUrlPunctuation(rawUrl: string): string {
  let url = rawUrl;
  while (url.length > 0) {
    const lastChar = url.at(-1);
    if (lastChar && /[.,!?;:'"]/.test(lastChar)) {
      url = url.slice(0, -1);
      continue;
    }
    if (lastChar === ')') {
      const openCount = (url.match(/\(/g) ?? []).length;
      const closeCount = (url.match(/\)/g) ?? []).length;
      if (closeCount > openCount) {
        url = url.slice(0, -1);
        continue;
      }
    }
    break;
  }
  return url;
}

function overlapsExistingSpan(
  start: number,
  end: number,
  spans: Array<{ start: number; end: number }>,
): boolean {
  return spans.some((span) => start < span.end && end > span.start);
}

/**
 * Detects URLs, @mentions, and #hashtags in text and computes exact UTF-8 byte offsets
 * so multi-byte emojis or accented characters preceding a facet never shift indices.
 */
export function detectBlueskyFacets(
  text: string,
  resolveMentions: Record<string, string> = {},
): BlueskyFacet[] {
  const occupiedUtf16Spans: Array<{ start: number; end: number }> = [];
  const facets: BlueskyFacet[] = [];

  // 1. Detect URLs first so fragments (#section) or userinfo (@) inside URLs are not re-parsed.
  const urlRegex = /https?:\/\/[^\s<>[\]{}"']+/g;
  for (const match of text.matchAll(urlRegex)) {
    const rawUrl = match[0];
    const start = match.index ?? 0;
    const cleanUrl = trimTrailingUrlPunctuation(rawUrl);
    if (!cleanUrl) continue;

    const end = start + cleanUrl.length;
    occupiedUtf16Spans.push({ start, end });

    const byteStart = utf8ByteOffset(text, start);
    const byteEnd = byteStart + utf8Encoder.encode(cleanUrl).byteLength;

    facets.push({
      index: { byteStart, byteEnd },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri: cleanUrl }],
    });
  }

  // 2. Detect AT Protocol domain-style @mentions (e.g., @sunshade.bsky.social).
  const mentionRegex = /(?:^|[\s(])(@([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+))/g;
  for (const match of text.matchAll(mentionRegex)) {
    const fullMatch = match[0];
    const mentionToken = match[1];
    const handle = match[2];
    if (!mentionToken || !handle) continue;

    const tokenOffsetInMatch = fullMatch.indexOf(mentionToken);
    const start = (match.index ?? 0) + tokenOffsetInMatch;
    const end = start + mentionToken.length;

    if (overlapsExistingSpan(start, end, occupiedUtf16Spans)) continue;
    occupiedUtf16Spans.push({ start, end });

    const byteStart = utf8ByteOffset(text, start);
    const byteEnd = byteStart + utf8Encoder.encode(mentionToken).byteLength;

    facets.push({
      index: { byteStart, byteEnd },
      features: [
        {
          $type: 'app.bsky.richtext.facet#mention',
          did: resolveMentions[handle] ?? handle,
        },
      ],
    });
  }

  // 3. Detect #hashtags (must contain at least one letter or underscore, max 64 chars).
  const hashtagRegex = /(?:^|[\s(])(#([\p{L}\p{N}_]*[\p{L}_][\p{L}\p{N}_]*))/gu;
  for (const match of text.matchAll(hashtagRegex)) {
    const fullMatch = match[0];
    const hashToken = match[1];
    const tag = match[2];
    if (!hashToken || !tag || tag.length > 64) continue;

    const tokenOffsetInMatch = fullMatch.indexOf(hashToken);
    const start = (match.index ?? 0) + tokenOffsetInMatch;
    const end = start + hashToken.length;

    if (overlapsExistingSpan(start, end, occupiedUtf16Spans)) continue;
    occupiedUtf16Spans.push({ start, end });

    const byteStart = utf8ByteOffset(text, start);
    const byteEnd = byteStart + utf8Encoder.encode(hashToken).byteLength;

    facets.push({
      index: { byteStart, byteEnd },
      features: [{ $type: 'app.bsky.richtext.facet#tag', tag }],
    });
  }

  return facets.sort((a, b) => a.index.byteStart - b.index.byteStart);
}

/**
 * Validates grapheme limits and builds a facet-indexed Bluesky post payload.
 * Throws `BlueskyGraphemeLimitError` if text exceeds 300 graphemes.
 */
export function formatBlueskyPost(
  text: string,
  options: { resolveMentions?: Record<string, string>; maxGraphemes?: number } = {},
): FormattedBlueskyPost {
  const maxGraphemes = options.maxGraphemes ?? BLUESKY_MAX_GRAPHEMES;
  const validation = validateBlueskyText(text, maxGraphemes);
  if (!validation.valid) {
    throw new BlueskyGraphemeLimitError(validation.graphemeCount, maxGraphemes);
  }

  const facets = detectBlueskyFacets(text, options.resolveMentions);
  return {
    text,
    facets,
    graphemeCount: validation.graphemeCount,
  };
}
