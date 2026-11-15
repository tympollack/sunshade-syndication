import { describe, expect, it, vi } from 'vitest';
import {
  MetaGraphAdapter,
} from '../../apps/syndication-worker/src/adapters/metaGraph.js';
import type { DispatchRequest } from '../../apps/syndication-worker/src/adapters/types.js';

describe('MetaGraphAdapter', () => {
  const baseRequest: DispatchRequest = {
    tenantId: 'tenant-meta-1',
    postId: 'post-meta-1',
    connectionId: 'conn-meta',
    platform: 'meta',
    text: 'Latest engineering update from SunShade Systems!',
    credentials: {
      pageId: 'page_123456789',
      pageAccessToken: 'test-meta-page-access-token',
    },
  };

  it('publishes a standard message post to /{page-id}/feed', async () => {
    let capturedUrl = '';
    let capturedParams: URLSearchParams | null = null;

    const fetchFn = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedParams = new URLSearchParams(String(init?.body));
      return new Response(JSON.stringify({ id: 'page_123456789_post_999' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const adapter = new MetaGraphAdapter({ fetchFn });
    const result = await adapter.dispatch(baseRequest);

    expect(result.success).toBe(true);
    expect(result.platformPostId).toBe('page_123456789_post_999');
    expect(result.platformUrl).toBe('https://facebook.com/page_123456789_post_999');
    expect(capturedUrl).toBe('https://graph.facebook.com/v21.0/page_123456789/feed');
    expect(capturedParams?.get('message')).toBe('Latest engineering update from SunShade Systems!');
    expect(capturedParams?.get('access_token')).toBe('test-meta-page-access-token');
    expect(capturedParams?.get('link')).toBeNull();
  });

  it('attaches link preview parameter when linkUrl is provided', async () => {
    let capturedParams: URLSearchParams | null = null;

    const fetchFn = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      capturedParams = new URLSearchParams(String(init?.body));
      return new Response(JSON.stringify({ id: 'page_123456789_post_link' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const adapter = new MetaGraphAdapter({ fetchFn });
    const result = await adapter.dispatch({
      ...baseRequest,
      linkUrl: 'https://sunshade.icu/updates/v2-release',
    });

    expect(result.success).toBe(true);
    expect(capturedParams?.get('link')).toBe('https://sunshade.icu/updates/v2-release');
  });

  it('configures scheduled publishing parameters when scheduledAt is >= 10 mins in future', async () => {
    let capturedParams: URLSearchParams | null = null;

    const fetchFn = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      capturedParams = new URLSearchParams(String(init?.body));
      return new Response(JSON.stringify({ id: 'page_123456789_post_scheduled' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const adapter = new MetaGraphAdapter({ fetchFn });

    // Schedule 1 hour in the future
    const futureDate = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const result = await adapter.dispatch({
      ...baseRequest,
      scheduledAt: futureDate,
    });

    expect(result.success).toBe(true);
    expect(capturedParams?.get('published')).toBe('false');
    const scheduledUnix = Number(capturedParams?.get('scheduled_publish_time'));
    expect(scheduledUnix).toBe(Math.floor(new Date(futureDate).getTime() / 1000));
  });

  it('rejects scheduled post when scheduled time is less than 10 minutes in the future', async () => {
    const fetchFn = vi.fn();
    const adapter = new MetaGraphAdapter({ fetchFn });

    // Only 5 minutes in future (too short for Meta API)
    const tooSoonDate = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const result = await adapter.dispatch({
      ...baseRequest,
      scheduledAt: tooSoonDate,
    });

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.error).toContain('must be at least 10 minutes in the future');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects scheduled post when scheduled time is more than 75 days in the future', async () => {
    const fetchFn = vi.fn();
    const adapter = new MetaGraphAdapter({ fetchFn });

    // 80 days in future
    const tooFarDate = new Date(Date.now() + 80 * 24 * 60 * 60 * 1000).toISOString();
    const result = await adapter.dispatch({
      ...baseRequest,
      scheduledAt: tooFarDate,
    });

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.error).toContain('cannot be more than 75 days in the future');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('uploads cover media to /{page-id}/photos and attaches attached_media on /{page-id}/feed', async () => {
    const photoUploads: any[] = [];
    let feedParams: URLSearchParams | null = null;

    const fetchFn = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/photos')) {
        const p = new URLSearchParams(String(init?.body));
        photoUploads.push({
          url,
          imageUrl: p.get('url'),
          published: p.get('published'),
        });
        return new Response(JSON.stringify({ id: `photo_fbid_${photoUploads.length}` }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.includes('/feed')) {
        feedParams = new URLSearchParams(String(init?.body));
        return new Response(JSON.stringify({ id: 'page_123456789_post_with_media' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response('Not found', { status: 404 });
    });

    const adapter = new MetaGraphAdapter({ fetchFn });
    const result = await adapter.dispatch({
      ...baseRequest,
      linkUrl: 'https://sunshade.icu/article',
      mediaUrls: ['https://cdn.example.com/cover1.jpg', 'https://cdn.example.com/cover2.jpg'],
    });

    expect(result.success).toBe(true);
    expect(photoUploads).toHaveLength(2);
    expect(photoUploads[0].imageUrl).toBe('https://cdn.example.com/cover1.jpg');
    expect(photoUploads[0].published).toBe('false');

    expect(feedParams).toBeDefined();
    // Facebook rejects posts that supply both 'link' and 'attached_media', so 'link' must be omitted
    expect(feedParams?.get('link')).toBeNull();
    const attachedMedia = JSON.parse(feedParams?.get('attached_media') ?? '[]');
    expect(attachedMedia).toEqual([
      { media_fbid: 'photo_fbid_1' },
      { media_fbid: 'photo_fbid_2' },
    ]);
  });

  it('returns simulated stub post in stub mode when accessToken is omitted', async () => {
    const fetchFn = vi.fn();
    const adapter = new MetaGraphAdapter({ fetchFn });

    const result = await adapter.dispatch({
      ...baseRequest,
      credentials: { pageId: 'page_custom_id' },
    });

    expect(result.success).toBe(true);
    expect(result.platformPostId).toMatch(/^page_custom_id_stub-/);
    expect(result.platformUrl).toMatch(/^https:\/\/facebook\.com\/page_custom_id_stub-/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('marks HTTP 429 rate limit and HTTP 5xx server errors as retryable', async () => {
    const fetch429 = vi.fn().mockResolvedValue(new Response('Rate limit', { status: 429 }));
    const adapter429 = new MetaGraphAdapter({ fetchFn: fetch429 });

    const res429 = await adapter429.dispatch(baseRequest);
    expect(res429.success).toBe(false);
    expect(res429.statusCode).toBe(429);
    expect(res429.retryable).toBe(true);

    const fetch500 = vi.fn().mockResolvedValue(new Response('Internal Error', { status: 500 }));
    const adapter500 = new MetaGraphAdapter({ fetchFn: fetch500 });

    const res500 = await adapter500.dispatch(baseRequest);
    expect(res500.success).toBe(false);
    expect(res500.statusCode).toBe(500);
    expect(res500.retryable).toBe(true);
  });

  it('marks HTTP 401 and 403 authorization failures as non-retryable', async () => {
    const fetch401 = vi.fn().mockResolvedValue(new Response('Invalid OAuth Token', { status: 401 }));
    const adapter = new MetaGraphAdapter({ fetchFn: fetch401 });

    const res401 = await adapter.dispatch(baseRequest);
    expect(res401.success).toBe(false);
    expect(res401.statusCode).toBe(401);
    expect(res401.retryable).toBe(false);
  });
});
