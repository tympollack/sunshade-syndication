export const X_MAX_TWEET_CHARS = 280;
export const X_LINK_RESERVE_CHARS = 24;

export interface XThreadOptions {
  /** Maximum characters per tweet (defaults to 280). */
  maxChars?: number;
  /** Reserved character budget on the anchor tweet for a t.co shortlink (defaults to 24). */
  linkReserveChars?: number;
  /** Optional shortlink (e.g. https://links.sunshade.icu/abc) attached to the anchor tweet. */
  shortUrl?: string;
}

export interface XThreadResult {
  /** Ordered tweet copy chunks. Chunk 0 respects `maxChars - linkReserveChars` (256 chars). */
  chunks: string[];
  /** Anchor tweet text with `shortUrl` appended when provided. */
  anchorTweetText: string;
  /** Effective character count of the anchor tweet under X's 23-char t.co URL rule. */
  anchorEffectiveLength: number;
  totalTweets: number;
}

function splitParagraphIntoSentences(paragraph: string): string[] {
  const trimmed = paragraph.replace(/\s+/g, ' ').trim();
  if (!trimmed) return [];

  const sentences = trimmed
    .split(/(?<=[.!?]["'”’)]?)\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  return sentences.length > 0 ? sentences : [trimmed];
}

function splitOversizedSegmentByWords(segment: string, limit: number): string[] {
  const words = segment.split(/\s+/).filter(Boolean);
  const parts: string[] = [];
  let current = '';

  for (const word of words) {
    if (word.length > limit) {
      if (current) {
        parts.push(current);
        current = '';
      }
      for (let i = 0; i < word.length; i += limit) {
        parts.push(word.slice(i, i + limit));
      }
      continue;
    }

    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= limit) {
      current = candidate;
    } else {
      if (current) parts.push(current);
      current = word;
    }
  }

  if (current) {
    parts.push(current);
  }

  return parts;
}

/**
 * Splits long copy into ordered X (Twitter) thread chunks at sentence and word boundaries.
 * Reserves `linkReserveChars` (24 chars by default) on the anchor tweet (index 0)
 * so the `links.sunshade.icu` shortlink never pushes the anchor tweet over 280 chars.
 */
export function splitIntoXThread(text: string, options: XThreadOptions = {}): XThreadResult {
  const maxChars = options.maxChars ?? X_MAX_TWEET_CHARS;
  const linkReserveChars = options.linkReserveChars ?? X_LINK_RESERVE_CHARS;
  const anchorLimit = Math.max(1, maxChars - linkReserveChars);

  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    const anchorTweetText = options.shortUrl ? options.shortUrl : '';
    return {
      chunks: [],
      anchorTweetText,
      anchorEffectiveLength: options.shortUrl ? linkReserveChars - 1 : 0,
      totalTweets: 0,
    };
  }

  const sentences = normalized
    .split(/\n+/)
    .flatMap((paragraph) => splitParagraphIntoSentences(paragraph));

  const chunks: string[] = [];
  let current = '';

  const currentLimit = (): number => (chunks.length === 0 ? anchorLimit : maxChars);

  for (const sentence of sentences) {
    const limit = currentLimit();
    const candidate = current ? `${current} ${sentence}` : sentence;

    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = '';
    }

    const nextLimit = currentLimit();
    if (sentence.length <= nextLimit) {
      current = sentence;
    } else {
      const wordChunks = splitOversizedSegmentByWords(sentence, nextLimit);
      for (let i = 0; i < wordChunks.length; i += 1) {
        const piece = wordChunks[i]!;
        if (i < wordChunks.length - 1) {
          chunks.push(piece);
        } else {
          current = piece;
        }
      }
    }
  }

  if (current) {
    chunks.push(current);
  }

  const anchorCopy = chunks[0] ?? '';
  const anchorTweetText = options.shortUrl
    ? anchorCopy
      ? `${anchorCopy} ${options.shortUrl}`
      : options.shortUrl
    : anchorCopy;

  const anchorEffectiveLength = options.shortUrl
    ? anchorCopy
      ? anchorCopy.length + linkReserveChars
      : linkReserveChars - 1
    : anchorCopy.length;

  return {
    chunks,
    anchorTweetText,
    anchorEffectiveLength,
    totalTweets: chunks.length,
  };
}
