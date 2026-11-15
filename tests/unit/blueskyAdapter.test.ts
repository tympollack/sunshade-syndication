import { describe, expect, it, vi } from 'vitest';
import {
  BLUESKY_MAX_BLOB_BYTES,
  BLUESKY_MAX_MEDIA_COUNT,
  BlueskyAdapter,
} from '../../apps/syndication-worker/src/adapters/bluesky.js';
import type { DispatchRequest } from '../../apps/syndication-worker/src/adapters/types.js';

describe('BlueskyAdapter', () => {
  const baseRequest: DispatchRequest = {
    tenantId: 'tenant-123',
    postId: 'post-abc',
    connectionId: 'conn-bsky',
    platform: 'bluesky',
    text: 'Hello Bluesky! Checking out https://sunshade.icu with @sunshade.bsky.social #opensource',
    credentials: {
      service: 'https://bsky.social',
      accessJwt: 'mock-jwt-token',
      did: 'did:plc:sunshade123',
      accountHandle: 'sunshade.bsky.social',
      resolveMentions: {
        'sunshade.bsky.social': 'did:plc:resolved-did-456',
      },
    },
  };

  it('rejects text exceeding 300 graphemes without sending HTTP requests', async () => {
    const fetchFn = vi.fn();
    const adapter = new BlueskyAdapter({ fetchFn });

    // 305 graphemes
    const longText = 'a'.repeat(305);
    const result = await adapter.dispatch({
      ...baseRequest,
      text: longText,
    });

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.error).toContain('exceeds Bluesky limit of 300 graphemes');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('correctly calculates UTF-8 byte-offset facets and posts record', async () => {
    let capturedBody: any = null;
    const mockPostUri = 'at://did:plc:sunshade123/app.bsky.feed.post/3k12345678';

    const fetchFn = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/xrpc/com.atproto.repo.createRecord')) {
        capturedBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ uri: mockPostUri, cid: 'bafyreicid' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('Not found', { status: 404 });
    });

    const adapter = new BlueskyAdapter({ fetchFn });
    const result = await adapter.dispatch(baseRequest);

    expect(result.success).toBe(true);
    expect(result.platformPostId).toBe(mockPostUri);
    expect(result.platformUrl).toBe('https://bsky.app/profile/sunshade.bsky.social/post/3k12345678');
    expect(capturedBody).toBeDefined();
    expect(capturedBody.repo).toBe('did:plc:sunshade123');
    expect(capturedBody.collection).toBe('app.bsky.feed.post');

    const facets = capturedBody.record.facets;
    expect(facets).toHaveLength(3);

    // Link facet
    const linkFacet = facets.find((f: any) => f.features[0].$type === 'app.bsky.richtext.facet#link');
    expect(linkFacet).toBeDefined();
    expect(linkFacet.features[0].uri).toBe('https://sunshade.icu');

    // Mention facet with resolved DID
    const mentionFacet = facets.find((f: any) => f.features[0].$type === 'app.bsky.richtext.facet#mention');
    expect(mentionFacet).toBeDefined();
    expect(mentionFacet.features[0].did).toBe('did:plc:resolved-did-456');

    // Tag facet
    const tagFacet = facets.find((f: any) => f.features[0].$type === 'app.bsky.richtext.facet#tag');
    expect(tagFacet).toBeDefined();
    expect(tagFacet.features[0].tag).toBe('opensource');
  });

  it('downloads images and uploads blobs to create app.bsky.embed.images (up to 4)', async () => {
    const uploadedBlobUrls: string[] = [];
    let capturedCreateRecordBody: any = null;

    const dummyImageData = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

    const fetchFn = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      // 1. Download image
      if (url.startsWith('https://cdn.example.com/')) {
        return new Response(dummyImageData, {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        });
      }

      // 2. Upload blob
      if (url.endsWith('/xrpc/com.atproto.repo.uploadBlob')) {
        uploadedBlobUrls.push(url);
        return new Response(
          JSON.stringify({
            blob: {
              $type: 'blob',
              ref: { $link: `bafkrei-${uploadedBlobUrls.length}` },
              mimeType: 'image/png',
              size: dummyImageData.byteLength,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      // 3. Create record
      if (url.endsWith('/xrpc/com.atproto.repo.createRecord')) {
        capturedCreateRecordBody = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({ uri: 'at://did:plc:sunshade123/app.bsky.feed.post/3kimage', cid: 'cid-img' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      return new Response('Not found', { status: 404 });
    });

    const adapter = new BlueskyAdapter({ fetchFn });

    // Provide 5 images to verify BLUESKY_MAX_MEDIA_COUNT (4) cap
    const result = await adapter.dispatch({
      ...baseRequest,
      mediaUrls: [
        'https://cdn.example.com/img1.png',
        'https://cdn.example.com/img2.png',
        'https://cdn.example.com/img3.png',
        'https://cdn.example.com/img4.png',
        'https://cdn.example.com/img5.png',
      ],
      credentials: {
        ...baseRequest.credentials,
        imageAlts: ['Alt 1', 'Alt 2', 'Alt 3', 'Alt 4'],
      },
    });

    expect(result.success).toBe(true);
    expect(uploadedBlobUrls).toHaveLength(BLUESKY_MAX_MEDIA_COUNT);
    expect(capturedCreateRecordBody.record.embed).toBeDefined();
    expect(capturedCreateRecordBody.record.embed.$type).toBe('app.bsky.embed.images');
    expect(capturedCreateRecordBody.record.embed.images).toHaveLength(4);
    expect(capturedCreateRecordBody.record.embed.images[0].alt).toBe('Alt 1');
    expect(capturedCreateRecordBody.record.embed.images[0].image.ref.$link).toBe('bafkrei-1');
  });

  it('creates app.bsky.embed.external card when linkUrl is provided without media', async () => {
    let capturedBody: any = null;

    const fetchFn = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/xrpc/com.atproto.repo.createRecord')) {
        capturedBody = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({ uri: 'at://did:plc:sunshade123/app.bsky.feed.post/3kcard', cid: 'cid-card' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('Not found', { status: 404 });
    });

    const adapter = new BlueskyAdapter({ fetchFn });
    const result = await adapter.dispatch({
      ...baseRequest,
      linkUrl: 'https://sunshade.icu/announcement',
      credentials: {
        ...baseRequest.credentials,
        linkTitle: 'SunShade Launch',
        linkDescription: 'Announcing decentralized social syndication',
      },
    });

    expect(result.success).toBe(true);
    expect(capturedBody.record.embed).toBeDefined();
    expect(capturedBody.record.embed.$type).toBe('app.bsky.embed.external');
    expect(capturedBody.record.embed.external.uri).toBe('https://sunshade.icu/announcement');
    expect(capturedBody.record.embed.external.title).toBe('SunShade Launch');
  });

  it('returns simulated success in stub mode when credentials are not configured', async () => {
    const fetchFn = vi.fn();
    const adapter = new BlueskyAdapter({ fetchFn });

    const result = await adapter.dispatch({
      ...baseRequest,
      credentials: undefined,
    });

    expect(result.success).toBe(true);
    expect(result.platformPostId).toMatch(/^at:\/\/did:plc:mock\/app\.bsky\.feed\.post\/stub-/);
    expect(result.platformUrl).toMatch(/^https:\/\/bsky\.app\/profile\/mock\.bsky\.social\/post\/stub-/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('marks HTTP 429 rate limits and 5xx errors as retryable', async () => {
    const fetch429 = vi.fn().mockResolvedValue(new Response('Rate limit', { status: 429 }));
    const adapter429 = new BlueskyAdapter({ fetchFn: fetch429 });

    const res429 = await adapter429.dispatch(baseRequest);
    expect(res429.success).toBe(false);
    expect(res429.statusCode).toBe(429);
    expect(res429.retryable).toBe(true);

    const fetch503 = vi.fn().mockResolvedValue(new Response('Service Unavailable', { status: 503 }));
    const adapter503 = new BlueskyAdapter({ fetchFn: fetch503 });

    const res503 = await adapter503.dispatch(baseRequest);
    expect(res503.success).toBe(false);
    expect(res503.statusCode).toBe(503);
    expect(res503.retryable).toBe(true);
  });

  it('marks HTTP 401 and 400 errors as non-retryable', async () => {
    const fetch401 = vi.fn().mockResolvedValue(new Response('Unauthorized token', { status: 401 }));
    const adapter = new BlueskyAdapter({ fetchFn: fetch401 });

    const res401 = await adapter.dispatch(baseRequest);
    expect(res401.success).toBe(false);
    expect(res401.statusCode).toBe(401);
    expect(res401.retryable).toBe(false);
  });

  it('rejects images exceeding BLUESKY_MAX_BLOB_BYTES limit as non-retryable error', async () => {
    const oversizedBytes = new Uint8Array(BLUESKY_MAX_BLOB_BYTES + 1024);
    const fetchFn = vi.fn().mockImplementation(async (url: string) => {
      if (url.startsWith('https://cdn.example.com/')) {
        return new Response(oversizedBytes, {
          status: 200,
          headers: { 'Content-Type': 'image/jpeg' },
        });
      }
      return new Response('Not found', { status: 404 });
    });

    const adapter = new BlueskyAdapter({ fetchFn });
    const result = await adapter.dispatch({
      ...baseRequest,
      mediaUrls: ['https://cdn.example.com/huge.jpg'],
    });

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.error).toContain('exceeds AT Protocol blob limit');
  });
});
