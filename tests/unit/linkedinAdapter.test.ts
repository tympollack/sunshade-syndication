import { describe, expect, it, vi } from 'vitest';
import { LinkedInAdapter } from '../../apps/syndication-worker/src/adapters/linkedin.js';
import type { DispatchRequest } from '../../apps/syndication-worker/src/adapters/types.js';

describe('LinkedInAdapter', () => {
  const baseRequest: DispatchRequest = {
    tenantId: 'tenant-123',
    postId: 'post-123',
    connectionId: 'conn-li',
    platform: 'linkedin',
    text: 'Exciting news from SunShade Systems!',
    credentials: {
      accessToken: 'test-linkedin-access-token',
      authorUrn: 'urn:li:person:user-789',
    },
  };

  it('posts with urn:li:person author target and category NONE', async () => {
    let capturedBody: any = null;

    const fetchFn = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'https://api.linkedin.com/v2/ugcPosts') {
        capturedBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ id: 'urn:li:share:share-100' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('Not found', { status: 404 });
    });

    const adapter = new LinkedInAdapter({ fetchFn });
    const result = await adapter.dispatch(baseRequest);

    expect(result.success).toBe(true);
    expect(result.platformPostId).toBe('urn:li:share:share-100');
    expect(result.platformUrl).toBe('https://www.linkedin.com/feed/update/urn:li:share:share-100');
    expect(capturedBody.author).toBe('urn:li:person:user-789');
    expect(capturedBody.specificContent['com.linkedin.ugc.ShareContent'].shareMediaCategory).toBe('NONE');
    expect(capturedBody.specificContent['com.linkedin.ugc.ShareContent'].shareCommentary.text).toBe(
      'Exciting news from SunShade Systems!',
    );
  });

  it('posts with urn:li:organization author target', async () => {
    let capturedBody: any = null;

    const fetchFn = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'https://api.linkedin.com/v2/ugcPosts') {
        capturedBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ id: 'urn:li:share:org-share-200' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('Not found', { status: 404 });
    });

    const adapter = new LinkedInAdapter({ fetchFn });
    const result = await adapter.dispatch({
      ...baseRequest,
      credentials: {
        accessToken: 'test-token',
        authorUrn: 'urn:li:organization:digitalcanopy-corp',
      },
    });

    expect(result.success).toBe(true);
    expect(capturedBody.author).toBe('urn:li:organization:digitalcanopy-corp');
  });

  it('rejects invalid author URN format as non-retryable error', async () => {
    const fetchFn = vi.fn();
    const adapter = new LinkedInAdapter({ fetchFn });

    const result = await adapter.dispatch({
      ...baseRequest,
      credentials: {
        accessToken: 'test-token',
        authorUrn: 'invalid-urn-format',
      },
    });

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.error).toContain("Must match format urn:li:person:... or urn:li:organization:...");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('registers upload asset, performs binary upload, and attaches IMAGE to UGC post', async () => {
    const registeredCalls: any[] = [];
    let binaryUploaded = false;
    let ugcPostBody: any = null;

    const dummyImageData = new Uint8Array([1, 2, 3, 4]);

    const fetchFn = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      // 1. Download image
      if (url === 'https://cdn.example.com/social-preview.png') {
        return new Response(dummyImageData, {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        });
      }

      // 2. Register upload
      if (url === 'https://api.linkedin.com/v2/assets?action=registerUpload') {
        registeredCalls.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({
            value: {
              asset: 'urn:li:digitalmediaAsset:asset-abc-123',
              uploadMechanism: {
                'com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest': {
                  uploadUrl: 'https://api.linkedin.com/mediaUpload/upload-target-1',
                  headers: { 'x-amz-server-side-encryption': 'aws:kms' },
                },
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      // 3. Binary PUT
      if (url === 'https://api.linkedin.com/mediaUpload/upload-target-1') {
        binaryUploaded = true;
        return new Response('', { status: 201 });
      }

      // 4. UGC Post
      if (url === 'https://api.linkedin.com/v2/ugcPosts') {
        ugcPostBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ id: 'urn:li:share:share-img-1' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response('Not found', { status: 404 });
    });

    const adapter = new LinkedInAdapter({ fetchFn });
    const result = await adapter.dispatch({
      ...baseRequest,
      mediaUrls: ['https://cdn.example.com/social-preview.png'],
      credentials: {
        ...baseRequest.credentials,
        imageTitles: ['SunShade Architecture Diagram'],
      },
    });

    expect(result.success).toBe(true);
    expect(registeredCalls).toHaveLength(1);
    expect(registeredCalls[0].registerUploadRequest.owner).toBe('urn:li:person:user-789');
    expect(binaryUploaded).toBe(true);

    expect(ugcPostBody.specificContent['com.linkedin.ugc.ShareContent'].shareMediaCategory).toBe('IMAGE');
    const media = ugcPostBody.specificContent['com.linkedin.ugc.ShareContent'].media;
    expect(media).toHaveLength(1);
    expect(media[0].status).toBe('READY');
    expect(media[0].media).toBe('urn:li:digitalmediaAsset:asset-abc-123');
    expect(media[0].title.text).toBe('SunShade Architecture Diagram');
  });

  it('attaches ARTICLE category and link preview when linkUrl is specified without media', async () => {
    let capturedBody: any = null;

    const fetchFn = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'https://api.linkedin.com/v2/ugcPosts') {
        capturedBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ id: 'urn:li:share:article-1' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('Not found', { status: 404 });
    });

    const adapter = new LinkedInAdapter({ fetchFn });
    const result = await adapter.dispatch({
      ...baseRequest,
      linkUrl: 'https://sunshade.icu/blog/release-v2',
      credentials: {
        ...baseRequest.credentials,
        linkTitle: 'Release v2 Overview',
      },
    });

    expect(result.success).toBe(true);
    expect(capturedBody.specificContent['com.linkedin.ugc.ShareContent'].shareMediaCategory).toBe('ARTICLE');
    const media = capturedBody.specificContent['com.linkedin.ugc.ShareContent'].media;
    expect(media[0].originalUrl).toBe('https://sunshade.icu/blog/release-v2');
    expect(media[0].title.text).toBe('Release v2 Overview');
  });

  it('returns simulated stub post in stub mode when credentials omitted', async () => {
    const fetchFn = vi.fn();
    const adapter = new LinkedInAdapter({ fetchFn });

    const result = await adapter.dispatch({
      ...baseRequest,
      credentials: undefined,
    });

    expect(result.success).toBe(true);
    expect(result.platformPostId).toMatch(/^urn:li:share:stub-/);
    expect(result.platformUrl).toMatch(/^https:\/\/www\.linkedin\.com\/feed\/update\/urn:li:share:stub-/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('marks HTTP 429 rate limit and HTTP 5xx server errors as retryable', async () => {
    const fetch429 = vi.fn().mockResolvedValue(new Response('Rate limit', { status: 429 }));
    const adapter429 = new LinkedInAdapter({ fetchFn: fetch429 });

    const res429 = await adapter429.dispatch(baseRequest);
    expect(res429.success).toBe(false);
    expect(res429.statusCode).toBe(429);
    expect(res429.retryable).toBe(true);

    const fetch502 = vi.fn().mockResolvedValue(new Response('Bad Gateway', { status: 502 }));
    const adapter502 = new LinkedInAdapter({ fetchFn: fetch502 });

    const res502 = await adapter502.dispatch(baseRequest);
    expect(res502.success).toBe(false);
    expect(res502.statusCode).toBe(502);
    expect(res502.retryable).toBe(true);
  });

  it('marks HTTP 401 unauthorized as non-retryable', async () => {
    const fetch401 = vi.fn().mockResolvedValue(new Response('Expired token', { status: 401 }));
    const adapter = new LinkedInAdapter({ fetchFn: fetch401 });

    const res = await adapter.dispatch(baseRequest);
    expect(res.success).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.retryable).toBe(false);
  });
});
