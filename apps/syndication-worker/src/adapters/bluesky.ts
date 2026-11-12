import {
  detectBlueskyFacets,
  validateBlueskyText,
} from '@digitalcanopy/syndication-core';
import type { DispatchRequest, DispatchResult, SocialAdapter } from './types.js';

/**
 * Bluesky / AT Protocol outbound social adapter stub.
 * Calculates UTF-8 byte offset facets and creates `app.bsky.feed.post` records.
 */
export class BlueskyAdapter implements SocialAdapter {
  readonly platform = 'bluesky' as const;

  async dispatch(request: DispatchRequest): Promise<DispatchResult> {
    const validation = validateBlueskyText(request.text);
    if (!validation.valid) {
      return {
        success: false,
        retryable: false,
        error: `Text exceeds Bluesky limit of 300 graphemes (got ${validation.graphemeCount}).`,
      };
    }

    const facets = detectBlueskyFacets(request.text);

    // When mock credentials or stub mode, simulate successful AT Protocol record creation.
    if (!request.credentials || !request.credentials['service']) {
      const mockRkey = `stub-${Date.now().toString(36)}`;
      return {
        success: true,
        platformPostId: `at://did:plc:mock/${mockRkey}`,
        platformUrl: `https://bsky.app/profile/mock.bsky.social/post/${mockRkey}`,
        retryable: false,
      };
    }

    try {
      const pdsUrl = String(request.credentials['service'] ?? 'https://bsky.social');
      const token = String(request.credentials['accessJwt'] ?? '');
      const did = String(request.credentials['did'] ?? '');

      const response = await fetch(`${pdsUrl}/xrpc/com.atproto.repo.createRecord`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          repo: did,
          collection: 'app.bsky.feed.post',
          record: {
            $type: 'app.bsky.feed.post',
            text: request.text,
            facets,
            createdAt: new Date().toISOString(),
          },
        }),
      });

      if (!response.ok) {
        const status = response.status;
        return {
          success: false,
          statusCode: status,
          retryable: status === 429 || status >= 500,
          error: `Bluesky API returned HTTP ${status}`,
        };
      }

      const body = (await response.json()) as { uri?: string; cid?: string };
      return {
        success: true,
        platformPostId: body.uri,
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
