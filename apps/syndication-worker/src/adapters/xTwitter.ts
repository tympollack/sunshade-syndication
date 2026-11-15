import { splitIntoXThread, X_MAX_TWEET_CHARS } from '@digitalcanopy/syndication-core';
import type { DispatchRequest, DispatchResult, SocialAdapter } from './types.js';

export const X_FREE_TIER_MONTHLY_QUOTA = 1500;

export interface XQuotaTracker {
  getMonthlyTweetCount(tenantId: string, yearMonth: string): Promise<number>;
  recordTweetsPublished(tenantId: string, yearMonth: string, count: number): Promise<void>;
}

/**
 * Default in-memory quota tracker keyed by `${tenantId}:${yearMonth}`.
 */
export class InMemoryXQuotaTracker implements XQuotaTracker {
  private readonly usage = new Map<string, number>();

  async getMonthlyTweetCount(tenantId: string, yearMonth: string): Promise<number> {
    return this.usage.get(`${tenantId}:${yearMonth}`) ?? 0;
  }

  async recordTweetsPublished(tenantId: string, yearMonth: string, count: number): Promise<void> {
    const key = `${tenantId}:${yearMonth}`;
    const current = this.usage.get(key) ?? 0;
    this.usage.set(key, current + count);
  }

  reset(): void {
    this.usage.clear();
  }
}

export interface XTwitterAdapterOptions {
  fetchFn?: typeof fetch;
  quotaTracker?: XQuotaTracker;
  monthlyQuota?: number;
}

/**
 * Returns current YYYY-MM string in UTC.
 */
export function getCurrentYearMonthUtc(date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/**
 * X (Twitter) API v2 outbound adapter.
 * Supports single tweets and threaded chunk dispatches with in_reply_to_tweet_id chaining,
 * 280-character boundary enforcement, and 1,500/mo Free Tier rate budget tracking.
 */
export class XTwitterAdapter implements SocialAdapter {
  readonly platform = 'x' as const;
  private readonly fetchFn: typeof fetch;
  private readonly quotaTracker: XQuotaTracker;
  private readonly defaultMonthlyQuota: number;

  constructor(options: XTwitterAdapterOptions = {}) {
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.quotaTracker = options.quotaTracker ?? new InMemoryXQuotaTracker();
    this.defaultMonthlyQuota = options.monthlyQuota ?? X_FREE_TIER_MONTHLY_QUOTA;
  }

  async dispatch(
    request: DispatchRequest,
    overrideOptions?: XTwitterAdapterOptions,
  ): Promise<DispatchResult> {
    const fetchFn = overrideOptions?.fetchFn ?? this.fetchFn;
    const quotaTracker = overrideOptions?.quotaTracker ?? this.quotaTracker;
    const monthlyQuota =
      (typeof request.credentials?.['monthlyQuota'] === 'number'
        ? (request.credentials['monthlyQuota'] as number)
        : overrideOptions?.monthlyQuota) ?? this.defaultMonthlyQuota;

    // 1. Thread Chunking and 280-Character Bound Validation
    let chunks: string[];
    if (request.threadChunks && request.threadChunks.length > 0) {
      chunks = request.threadChunks;
    } else if (request.text.length > X_MAX_TWEET_CHARS) {
      const threadResult = splitIntoXThread(request.text, { shortUrl: request.linkUrl });
      chunks = threadResult.chunks.length > 0 ? threadResult.chunks : [request.text];
    } else {
      const singleText = request.linkUrl ? `${request.text} ${request.linkUrl}` : request.text;
      if (singleText.length <= X_MAX_TWEET_CHARS) {
        chunks = [singleText];
      } else {
        const threadResult = splitIntoXThread(request.text, { shortUrl: request.linkUrl });
        chunks = threadResult.chunks.length > 0 ? threadResult.chunks : [request.text];
      }
    }

    // Validate that every chunk fits within the 280-char limit
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      if (chunk.length > X_MAX_TWEET_CHARS) {
        return {
          success: false,
          retryable: false,
          error: `Tweet chunk at index ${i} exceeds ${X_MAX_TWEET_CHARS} characters (got ${chunk.length} chars).`,
        };
      }
    }

    const currentYearMonth = getCurrentYearMonthUtc();

    // 2. 1,500/mo Free Tier Quota Guard
    let currentUsage = await quotaTracker.getMonthlyTweetCount(request.tenantId, currentYearMonth);
    if (typeof request.credentials?.['currentMonthlyUsage'] === 'number') {
      currentUsage = Math.max(currentUsage, Number(request.credentials['currentMonthlyUsage']));
    }

    if (currentUsage + chunks.length > monthlyQuota) {
      return {
        success: false,
        statusCode: 429,
        retryable: false,
        error: `X API monthly Free Tier quota exceeded: monthly limit is ${monthlyQuota}, current usage is ${currentUsage}, requested dispatch of ${chunks.length} tweets.`,
      };
    }

    // 3. Stub / Mock mode when bearerToken is omitted
    if (!request.credentials || !request.credentials['bearerToken']) {
      const mockRootId = `1800000000000000${Math.floor(Math.random() * 1000)}`;
      await quotaTracker.recordTweetsPublished(request.tenantId, currentYearMonth, chunks.length);
      return {
        success: true,
        platformPostId: mockRootId,
        platformUrl: `https://x.com/SunShadeSystems/status/${mockRootId}`,
        statusCode: 200,
        retryable: false,
      };
    }

    try {
      const token = String(request.credentials['bearerToken']);
      let rootTweetId: string | undefined;
      let lastTweetId: string | undefined;
      let publishedCount = 0;

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]!;
        const payload: Record<string, unknown> = { text: chunk };

        if (lastTweetId) {
          payload['reply'] = { in_reply_to_tweet_id: lastTweetId };
        }

        // Attach media IDs to anchor tweet if provided
        if (i === 0 && Array.isArray(request.credentials['mediaIds']) && request.credentials['mediaIds'].length > 0) {
          payload['media'] = { media_ids: request.credentials['mediaIds'] };
        }

        const response = await fetchFn('https://api.twitter.com/2/tweets', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const status = response.status;
          if (publishedCount > 0) {
            await quotaTracker.recordTweetsPublished(request.tenantId, currentYearMonth, publishedCount);
          }
          return {
            success: false,
            platformPostId: rootTweetId,
            statusCode: status,
            retryable: status === 429 || status >= 500,
            error: `X API returned HTTP ${status} while publishing tweet ${i + 1}/${chunks.length}`,
          };
        }

        const resData = (await response.json()) as { data?: { id?: string } };
        const publishedId = resData.data?.id;

        if (!rootTweetId) {
          rootTweetId = publishedId;
        }
        lastTweetId = publishedId;
        publishedCount += 1;
      }

      await quotaTracker.recordTweetsPublished(request.tenantId, currentYearMonth, publishedCount);

      return {
        success: true,
        platformPostId: rootTweetId ?? lastTweetId,
        platformUrl: rootTweetId ? `https://x.com/i/status/${rootTweetId}` : undefined,
        statusCode: 201,
        retryable: false,
      };
    } catch (err) {
      return {
        success: false,
        retryable: true,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
