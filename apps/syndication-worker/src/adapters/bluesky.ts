import {
  detectBlueskyFacets,
  validateBlueskyText,
} from '@digitalcanopy/syndication-core';
import type { DispatchRequest, DispatchResult, SocialAdapter } from './types.js';

export interface BlueskyBlobRef {
  $type: 'blob';
  ref: {
    $link: string;
  };
  mimeType: string;
  size: number;
}

export interface BlueskyImageEmbedItem {
  alt: string;
  image: BlueskyBlobRef;
  aspectRatio?: { width: number; height: number };
}

export interface BlueskyExternalEmbed {
  $type: 'app.bsky.embed.external';
  external: {
    uri: string;
    title: string;
    description: string;
    thumb?: BlueskyBlobRef;
  };
}

export interface BlueskyImagesEmbed {
  $type: 'app.bsky.embed.images';
  images: BlueskyImageEmbedItem[];
}

export type BlueskyEmbed = BlueskyImagesEmbed | BlueskyExternalEmbed;

export interface BlueskyAdapterOptions {
  fetchFn?: typeof fetch;
}

export const BLUESKY_MAX_MEDIA_COUNT = 4;
export const BLUESKY_MAX_BLOB_BYTES = 1000 * 1000; // ~1MB AT Proto blob limit

/**
 * Bluesky / AT Protocol outbound social adapter.
 * Performs 300-grapheme validation, calculates UTF-8 byte-offset facets,
 * uploads images via com.atproto.repo.uploadBlob, and creates app.bsky.feed.post records.
 */
export class BlueskyAdapter implements SocialAdapter {
  readonly platform = 'bluesky' as const;
  private readonly fetchFn: typeof fetch;

  constructor(options: BlueskyAdapterOptions = {}) {
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  async dispatch(
    request: DispatchRequest,
    overrideOptions?: BlueskyAdapterOptions,
  ): Promise<DispatchResult> {
    const fetchFn = overrideOptions?.fetchFn ?? this.fetchFn;

    // 1. Strict 300-grapheme limit check
    const validation = validateBlueskyText(request.text);
    if (!validation.valid) {
      return {
        success: false,
        retryable: false,
        error: `Text exceeds Bluesky limit of 300 graphemes (got ${validation.graphemeCount}).`,
      };
    }

    // 2. Mentions & Facet resolution with UTF-8 byte offsets
    const resolveMentions = (request.credentials?.['resolveMentions'] as Record<string, string>) ?? {};
    const facets = detectBlueskyFacets(request.text, resolveMentions);

    // 3. Stub / Mock mode when no credentials provided
    if (!request.credentials || (!request.credentials['service'] && !request.credentials['accessJwt'])) {
      const mockRkey = `stub-${Date.now().toString(36)}`;
      const mockDid = String(request.credentials?.['did'] ?? 'did:plc:mock');
      const mockHandle = String(request.credentials?.['accountHandle'] ?? 'mock.bsky.social');
      return {
        success: true,
        platformPostId: `at://${mockDid}/app.bsky.feed.post/${mockRkey}`,
        platformUrl: `https://bsky.app/profile/${mockHandle}/post/${mockRkey}`,
        statusCode: 200,
        retryable: false,
      };
    }

    try {
      const pdsUrl = String(request.credentials['service'] ?? 'https://bsky.social').replace(/\/+$/, '');
      const token = String(request.credentials['accessJwt'] ?? '');
      const did = String(request.credentials['did'] ?? '');
      const accountHandle = String(request.credentials['accountHandle'] ?? did);

      if (!token || !did) {
        return {
          success: false,
          statusCode: 401,
          retryable: false,
          error: 'Missing Bluesky accessJwt or did in credentials',
        };
      }

      // 4. Handle Media Embeds or Link Preview Embed
      let embed: BlueskyEmbed | undefined;

      if (request.mediaUrls && request.mediaUrls.length > 0) {
        const targetMediaUrls = request.mediaUrls.slice(0, BLUESKY_MAX_MEDIA_COUNT);
        const imageAlts = (request.credentials?.['imageAlts'] as string[]) ?? [];
        const uploadedBlobs: BlueskyBlobRef[] = [];

        for (let i = 0; i < targetMediaUrls.length; i++) {
          const mediaUrl = targetMediaUrls[i]!;

          // Download image asset
          let imageResponse: Response;
          try {
            imageResponse = await fetchFn(mediaUrl);
          } catch (err) {
            return {
              success: false,
              retryable: true,
              error: `Failed to download media image from ${mediaUrl}: ${err instanceof Error ? err.message : String(err)}`,
            };
          }

          if (!imageResponse.ok) {
            return {
              success: false,
              statusCode: imageResponse.status,
              retryable: imageResponse.status === 429 || imageResponse.status >= 500,
              error: `Media download returned HTTP ${imageResponse.status} for ${mediaUrl}`,
            };
          }

          const arrayBuffer = await imageResponse.arrayBuffer();
          const contentType = imageResponse.headers.get('content-type') || 'image/jpeg';

          if (arrayBuffer.byteLength > BLUESKY_MAX_BLOB_BYTES) {
            return {
              success: false,
              retryable: false,
              error: `Media image exceeds AT Protocol blob limit of ${BLUESKY_MAX_BLOB_BYTES} bytes (${arrayBuffer.byteLength} bytes).`,
            };
          }

          // Upload blob to PDS via com.atproto.repo.uploadBlob
          const uploadResponse = await fetchFn(`${pdsUrl}/xrpc/com.atproto.repo.uploadBlob`, {
            method: 'POST',
            headers: {
              'Content-Type': contentType,
              Authorization: `Bearer ${token}`,
            },
            body: arrayBuffer,
          });

          if (!uploadResponse.ok) {
            const status = uploadResponse.status;
            return {
              success: false,
              statusCode: status,
              retryable: status === 429 || status >= 500,
              error: `Bluesky uploadBlob returned HTTP ${status}`,
            };
          }

          const uploadData = (await uploadResponse.json()) as { blob?: BlueskyBlobRef };
          if (!uploadData.blob) {
            return {
              success: false,
              retryable: false,
              error: 'Bluesky uploadBlob response omitted blob reference',
            };
          }

          uploadedBlobs.push(uploadData.blob);
        }

        embed = {
          $type: 'app.bsky.embed.images',
          images: uploadedBlobs.map((blob, index) => ({
            alt: imageAlts[index] ?? '',
            image: blob,
          })),
        };
      } else if (request.linkUrl) {
        embed = {
          $type: 'app.bsky.embed.external',
          external: {
            uri: request.linkUrl,
            title: String(request.credentials?.['linkTitle'] ?? ''),
            description: String(request.credentials?.['linkDescription'] ?? ''),
          },
        };
      }

      // 5. Create app.bsky.feed.post Record
      const recordPayload: Record<string, unknown> = {
        $type: 'app.bsky.feed.post',
        text: request.text,
        facets,
        createdAt: new Date().toISOString(),
      };

      if (embed) {
        recordPayload['embed'] = embed;
      }

      const response = await fetchFn(`${pdsUrl}/xrpc/com.atproto.repo.createRecord`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          repo: did,
          collection: 'app.bsky.feed.post',
          record: recordPayload,
        }),
      });

      if (!response.ok) {
        const status = response.status;
        return {
          success: false,
          statusCode: status,
          retryable: status === 429 || status >= 500,
          error: `Bluesky createRecord returned HTTP ${status}`,
        };
      }

      const body = (await response.json()) as { uri?: string; cid?: string };
      const uri = body.uri;
      const rkey = uri ? uri.split('/').pop() : undefined;
      const platformUrl = rkey
        ? `https://bsky.app/profile/${accountHandle}/post/${rkey}`
        : undefined;

      return {
        success: true,
        platformPostId: uri,
        platformUrl,
        statusCode: 200,
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
