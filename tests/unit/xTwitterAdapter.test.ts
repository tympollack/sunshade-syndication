import { describe, expect, it, vi } from 'vitest';
import {
  calculateXEffectiveLength,
  getCurrentYearMonthUtc,
  InMemoryXQuotaTracker,
  XTwitterAdapter,
} from '../../apps/syndication-worker/src/adapters/xTwitter.js';
import type { DispatchRequest } from '../../apps/syndication-worker/src/adapters/types.js';

describe('XTwitterAdapter', () => {
  const currentMonth = getCurrentYearMonthUtc();

  const baseRequest: DispatchRequest = {
    tenantId: 'tenant-x-1',
    postId: 'post-x-1',
    connectionId: 'conn-x',
    platform: 'x',
    text: 'Building decentralized syndication engines with SunShade!',
    credentials: {
      bearerToken: 'test-x-bearer-token',
    },
  };

  it('posts a single tweet within 280 characters', async () => {
    let capturedBody: any = null;

    const fetchFn = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'https://api.twitter.com/2/tweets') {
        capturedBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ data: { id: 'tweet-single-1' } }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('Not found', { status: 404 });
    });

    const quotaTracker = new InMemoryXQuotaTracker();
    const adapter = new XTwitterAdapter({ fetchFn, quotaTracker });
    const result = await adapter.dispatch(baseRequest);

    expect(result.success).toBe(true);
    expect(result.platformPostId).toBe('tweet-single-1');
    expect(result.platformUrl).toBe('https://x.com/i/status/tweet-single-1');
    expect(capturedBody.text).toBe('Building decentralized syndication engines with SunShade!');
    expect(capturedBody.reply).toBeUndefined();

    // Quota should increment by 1
    const count = await quotaTracker.getMonthlyTweetCount('tenant-x-1', currentMonth);
    expect(count).toBe(1);
  });

  it('automatically splits long copy (>280 chars) into threaded replies and preserves linkUrl on anchor tweet', async () => {
    const postRequests: any[] = [];
    let tweetIndex = 0;

    const fetchFn = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'https://api.twitter.com/2/tweets') {
        tweetIndex++;
        postRequests.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ data: { id: `tweet-thread-${tweetIndex}` } }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('Not found', { status: 404 });
    });

    const quotaTracker = new InMemoryXQuotaTracker();
    const adapter = new XTwitterAdapter({ fetchFn, quotaTracker });

    const longText =
      'First part of the long discussion on distributed systems. ' +
      'Every system must manage fault isolation, retry queues, and monotonic backoff schemes. ' +
      'When an external API returns HTTP 429, the orchestrator must back off without blocking independent social platforms. ' +
      'Second part dives into cryptographic token vaults using pgsodium and row level security policies. ' +
      'Finally, each broadcast is verifiable via tracker audit logs and immutable hashes.';

    const linkUrl = 'https://links.sunshade.icu/s/deep-dive-arch';

    const result = await adapter.dispatch({
      ...baseRequest,
      text: longText,
      linkUrl,
    });

    expect(result.success).toBe(true);
    expect(postRequests.length).toBeGreaterThan(1);
    expect(result.platformPostId).toBe('tweet-thread-1'); // Root tweet ID

    // Root tweet must include the destination shortlink
    expect(postRequests[0].text).toContain(linkUrl);
    expect(postRequests[0].reply).toBeUndefined();

    // Subsequent tweets chain in_reply_to_tweet_id
    for (let i = 1; i < postRequests.length; i++) {
      expect(postRequests[i].reply.in_reply_to_tweet_id).toBe(`tweet-thread-${i}`);
    }

    const count = await quotaTracker.getMonthlyTweetCount('tenant-x-1', currentMonth);
    expect(count).toBe(postRequests.length);
  });

  it('uses explicitly provided threadChunks and chains replies', async () => {
    const postRequests: any[] = [];
    let tweetIndex = 0;

    const fetchFn = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'https://api.twitter.com/2/tweets') {
        tweetIndex++;
        postRequests.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ data: { id: `manual-tweet-${tweetIndex}` } }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('Not found', { status: 404 });
    });

    const quotaTracker = new InMemoryXQuotaTracker();
    const adapter = new XTwitterAdapter({ fetchFn, quotaTracker });

    const result = await adapter.dispatch({
      ...baseRequest,
      threadChunks: ['Chunk 1: Overview', 'Chunk 2: Architecture', 'Chunk 3: Deployment'],
    });

    expect(result.success).toBe(true);
    expect(postRequests).toHaveLength(3);
    expect(postRequests[0].text).toBe('Chunk 1: Overview');
    expect(postRequests[1].reply.in_reply_to_tweet_id).toBe('manual-tweet-1');
    expect(postRequests[2].reply.in_reply_to_tweet_id).toBe('manual-tweet-2');
  });

  it('accepts valid URL-bearing chunks where raw length > 280 but effective t.co length <= 280', async () => {
    let capturedBody: any = null;

    const fetchFn = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'https://api.twitter.com/2/tweets') {
        capturedBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ data: { id: 'tweet-url-1' } }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('Not found', { status: 404 });
    });

    // 256 ASCII characters + 1 space + a 50-character URL = 307 raw chars, but 256 + 1 + 23 = 280 effective chars
    const longUrl = 'https://sunshade.icu/articles/2026/11/super-long-custom-slug-here';
    const textWithLongUrl = `${'a'.repeat(256)} ${longUrl}`;

    expect(textWithLongUrl.length).toBeGreaterThan(280);
    expect(calculateXEffectiveLength(textWithLongUrl)).toBe(280);

    const adapter = new XTwitterAdapter({ fetchFn });
    const result = await adapter.dispatch({
      ...baseRequest,
      threadChunks: [textWithLongUrl],
    });

    expect(result.success).toBe(true);
    expect(capturedBody.text).toBe(textWithLongUrl);
  });

  it('rejects any tweet chunk whose effective length exceeds 280 characters', async () => {
    const fetchFn = vi.fn();
    const adapter = new XTwitterAdapter({ fetchFn });

    const result = await adapter.dispatch({
      ...baseRequest,
      threadChunks: ['Valid chunk', 'a'.repeat(281)],
    });

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.error).toContain('exceeds 280 characters');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('enforces 1,500/mo Free Tier quota guard and blocks dispatch when budget exceeded', async () => {
    const fetchFn = vi.fn();
    const quotaTracker = new InMemoryXQuotaTracker();

    // Simulate 1,499 tweets already published this month
    await quotaTracker.recordTweetsPublished('tenant-x-1', currentMonth, 1499);

    const adapter = new XTwitterAdapter({ fetchFn, quotaTracker });

    // Requesting 2 tweets in a thread exceeds 1500 limit (1499 + 2 = 1501)
    const result = await adapter.dispatch({
      ...baseRequest,
      threadChunks: ['Tweet 1', 'Tweet 2'],
    });

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(429);
    expect(result.retryable).toBe(false);
    expect(result.error).toContain('X API monthly Free Tier quota exceeded');
    expect(result.error).toContain('monthly limit is 1500');
    expect(result.error).toContain('current usage is 1499');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('correctly accumulates successive dispatches on top of supplied baseline usage', async () => {
    const fetchFn = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ data: { id: 'tweet-acc' } }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const quotaTracker = new InMemoryXQuotaTracker();
    const adapter = new XTwitterAdapter({ fetchFn, quotaTracker });

    // First dispatch with baseline 1498 -> usage becomes 1498 + 1 = 1499
    const res1 = await adapter.dispatch({
      ...baseRequest,
      threadChunks: ['Tweet A'],
      credentials: {
        ...baseRequest.credentials,
        currentMonthlyUsage: 1498,
      },
    });
    expect(res1.success).toBe(true);

    // Second dispatch -> usage becomes 1499 + 1 = 1500 (allowed)
    const res2 = await adapter.dispatch({
      ...baseRequest,
      threadChunks: ['Tweet B'],
      credentials: {
        ...baseRequest.credentials,
        currentMonthlyUsage: 1498,
      },
    });
    expect(res2.success).toBe(true);

    // Third dispatch -> usage is 1500 + 1 = 1501 (exceeds 1500 cap -> rejected)
    const res3 = await adapter.dispatch({
      ...baseRequest,
      threadChunks: ['Tweet C'],
      credentials: {
        ...baseRequest.credentials,
        currentMonthlyUsage: 1498,
      },
    });
    expect(res3.success).toBe(false);
    expect(res3.statusCode).toBe(429);
  });

  it('records quota published and returns rootTweetId when subsequent thread request throws network error', async () => {
    let callIndex = 0;
    const fetchFn = vi.fn().mockImplementation(async () => {
      callIndex++;
      if (callIndex === 1) {
        return new Response(JSON.stringify({ data: { id: 'tweet-net-1' } }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error('Network socket disconnected');
    });

    const quotaTracker = new InMemoryXQuotaTracker();
    const adapter = new XTwitterAdapter({ fetchFn, quotaTracker });

    const result = await adapter.dispatch({
      ...baseRequest,
      threadChunks: ['Tweet 1 succeeds', 'Tweet 2 throws'],
    });

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.platformPostId).toBe('tweet-net-1');
    expect(result.error).toContain('Network socket disconnected');

    // 1 tweet succeeded before network failure, so 1 should be recorded
    const count = await quotaTracker.getMonthlyTweetCount('tenant-x-1', currentMonth);
    expect(count).toBe(1);
  });

  it('attaches media_ids to anchor tweet when provided in credentials', async () => {
    let capturedBody: any = null;

    const fetchFn = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'https://api.twitter.com/2/tweets') {
        capturedBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ data: { id: 'tweet-with-media' } }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('Not found', { status: 404 });
    });

    const adapter = new XTwitterAdapter({ fetchFn });
    const result = await adapter.dispatch({
      ...baseRequest,
      credentials: {
        ...baseRequest.credentials,
        mediaIds: ['1122334455'],
      },
    });

    expect(result.success).toBe(true);
    expect(capturedBody.media).toBeDefined();
    expect(capturedBody.media.media_ids).toEqual(['1122334455']);
  });

  it('returns simulated stub post in stub mode when bearerToken is omitted', async () => {
    const fetchFn = vi.fn();
    const quotaTracker = new InMemoryXQuotaTracker();
    const adapter = new XTwitterAdapter({ fetchFn, quotaTracker });

    const result = await adapter.dispatch({
      ...baseRequest,
      credentials: undefined,
    });

    expect(result.success).toBe(true);
    expect(result.platformPostId).toMatch(/^1800000000000000\d+/);
    expect(result.platformUrl).toMatch(/^https:\/\/x\.com\/SunShadeSystems\/status\//);
    expect(fetchFn).not.toHaveBeenCalled();

    const count = await quotaTracker.getMonthlyTweetCount('tenant-x-1', currentMonth);
    expect(count).toBe(1);
  });
});
