import type { SocialPlatform } from '../schemas.js';
import { BLUESKY_MAX_GRAPHEMES, countGraphemes } from './blueskyFacets.js';
import { splitIntoXThread } from './xThreader.js';

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&rsquo;': '\u2019',
  '&lsquo;': '\u2018',
  '&rdquo;': '\u201d',
  '&ldquo;': '\u201c',
  '&mdash;': '\u2014',
  '&ndash;': '\u2013',
  '&nbsp;': ' ',
};

/**
 * Strips HTML tags, decodes common HTML entities, and normalizes whitespace.
 */
export function normalizeCopy(raw: string): string {
  const withoutTags = raw.replace(/<[^>]+>/g, ' ');
  const decoded = withoutTags.replace(
    /&(?:amp|lt|gt|quot|#39|apos|rsquo|lsquo|rdquo|ldquo|mdash|ndash|nbsp);/g,
    (entity) => HTML_ENTITIES[entity] ?? entity,
  );
  return decoded.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Appends standard UTM tracking query parameters cleanly via `URL`.
 */
export function appendUtmParams(
  rawUrl: string,
  params: {
    source: string;
    medium?: string;
    campaign?: string;
    content?: string;
  },
): string {
  const url = new URL(rawUrl);
  url.searchParams.set('utm_source', params.source);
  url.searchParams.set('utm_medium', params.medium ?? 'social');
  if (params.campaign) {
    url.searchParams.set('utm_campaign', params.campaign);
  }
  if (params.content) {
    url.searchParams.set('utm_content', params.content);
  }
  return url.toString();
}

function truncateGraphemes(text: string, maxGraphemes: number): string {
  if (countGraphemes(text) <= maxGraphemes) return text;
  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
  const segments: string[] = [];
  for (const seg of segmenter.segment(text)) {
    if (segments.length >= maxGraphemes - 1) break;
    segments.push(seg.segment);
  }
  return `${segments.join('').trimEnd()}\u2026`;
}

export interface ExcerptInput {
  title: string;
  body: string;
  url: string;
  platform: SocialPlatform;
  shortUrl?: string;
  campaign?: string;
  tags?: string[];
}

export interface FormattedPlatformExcerpt {
  text: string;
  linkUrl: string;
  threadChunks?: string[];
}

/**
 * Builds platform-normalized copy with shortlink or UTM-tagged destination URL.
 */
export function buildPlatformExcerpt(input: ExcerptInput): FormattedPlatformExcerpt {
  const title = normalizeCopy(input.title);
  const body = normalizeCopy(input.body);
  const linkUrl =
    input.shortUrl ??
    appendUtmParams(input.url, {
      source: input.platform,
      medium: 'social',
      campaign: input.campaign ?? 'syndication',
    });

  const hashtags = (input.tags ?? [])
    .map((tag) => tag.replace(/[^a-zA-Z0-9_]/g, ''))
    .filter(Boolean)
    .slice(0, 4)
    .map((tag) => `#${tag}`)
    .join(' ');

  if (input.platform === 'x') {
    const combined = body ? `${title} — ${body}` : title;
    const thread = splitIntoXThread(combined, { shortUrl: linkUrl });
    return {
      text: thread.anchorTweetText,
      linkUrl,
      threadChunks: thread.chunks,
    };
  }

  if (input.platform === 'bluesky') {
    const suffix = hashtags ? `\n\n${linkUrl}\n${hashtags}` : `\n\n${linkUrl}`;
    const suffixGraphemes = countGraphemes(suffix);
    const copyBudget = Math.max(1, BLUESKY_MAX_GRAPHEMES - suffixGraphemes);
    const rawCopy = body ? `${title}\n\n${body}` : title;
    const boundedCopy = truncateGraphemes(rawCopy, copyBudget);
    return {
      text: `${boundedCopy}${suffix}`,
      linkUrl,
    };
  }

  const maxChars = input.platform === 'linkedin' ? 2800 : 1800;
  const footer = hashtags ? `\n\n${linkUrl}\n\n${hashtags}` : `\n\n${linkUrl}`;
  const rawCopy = body ? `${title}\n\n${body}` : title;
  const available = Math.max(1, maxChars - footer.length);
  const boundedCopy =
    rawCopy.length > available ? `${rawCopy.slice(0, available - 1).trimEnd()}\u2026` : rawCopy;

  return {
    text: `${boundedCopy}${footer}`,
    linkUrl,
  };
}
