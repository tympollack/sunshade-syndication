import type { DispatchRequest, DispatchResult, SocialAdapter } from './types.js';

/**
 * X (Twitter) API v2 outbound adapter stub.
 * Supports single tweets and threaded chunk dispatches with in_reply_to_tweet_id chaining.
 */
export class XTwitterAdapter implements SocialAdapter {
  readonly platform = 'x' as const;

  async dispatch(request: DispatchRequest): Promise<DispatchResult> {
    if (!request.credentials || !request.credentials['bearerToken']) {
      return {
        success: true,
        platformPostId: `1800000000000000${Math.floor(Math.random() * 1000)}`,
        platformUrl: 'https://x.com/SunShadeSystems/status/mock-tweet',
        retryable: false,
      };
    }

    try {
      const token = String(request.credentials['bearerToken']);
      const chunks = request.threadChunks && request.threadChunks.length > 0
        ? request.threadChunks
        : [request.text];

      let lastTweetId: string | undefined;

      for (const chunk of chunks) {
        const payload: Record<string, unknown> = { text: chunk };
        if (lastTweetId) {
          payload['reply'] = { in_reply_to_tweet_id: lastTweetId };
        }

        const response = await fetch('https://api.twitter.com/2/tweets', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const status = response.status;
          return {
            success: false,
            statusCode: status,
            retryable: status === 429 || status >= 500,
            error: `X API returned HTTP ${status}`,
          };
        }

        const resData = (await response.json()) as { data?: { id?: string } };
        lastTweetId = resData.data?.id;
      }

      return {
        success: true,
        platformPostId: lastTweetId,
        platformUrl: lastTweetId ? `https://x.com/status/${lastTweetId}` : undefined,
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
