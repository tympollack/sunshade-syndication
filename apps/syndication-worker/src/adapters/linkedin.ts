import type { DispatchRequest, DispatchResult, SocialAdapter } from './types.js';

/**
 * LinkedIn REST v2 outbound social adapter stub.
 * Supports person URNs (`urn:li:person:...`) and organization URNs (`urn:li:organization:...`).
 */
export class LinkedInAdapter implements SocialAdapter {
  readonly platform = 'linkedin' as const;

  async dispatch(request: DispatchRequest): Promise<DispatchResult> {
    if (!request.credentials || !request.credentials['accessToken']) {
      return {
        success: true,
        platformPostId: `urn:li:share:stub-${Date.now().toString(36)}`,
        platformUrl: `https://www.linkedin.com/feed/update/urn:li:share:stub`,
        retryable: false,
      };
    }

    try {
      const accessToken = String(request.credentials['accessToken']);
      const authorUrn = String(
        request.credentials['authorUrn'] ?? 'urn:li:person:mock-person-urn',
      );

      const payload = {
        author: authorUrn,
        lifecycleState: 'PUBLISHED',
        specificContent: {
          'com.linkedin.ugc.ShareContent': {
            shareCommentary: { text: request.text },
            shareMediaCategory: request.linkUrl ? 'ARTICLE' : 'NONE',
            ...(request.linkUrl
              ? {
                  media: [
                    {
                      status: 'READY',
                      originalUrl: request.linkUrl,
                    },
                  ],
                }
              : {}),
          },
        },
        visibility: {
          'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
        },
      };

      const response = await fetch('https://api.linkedin.com/v2/ugcPosts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Restli-Protocol-Version': '2.0.0',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const status = response.status;
        return {
          success: false,
          statusCode: status,
          // 429 rate limit or 5xx is retryable; 401/403 auth errors are non-retryable
          retryable: status === 429 || status >= 500,
          error: `LinkedIn API error HTTP ${status}`,
        };
      }

      const body = (await response.json()) as { id?: string };
      return {
        success: true,
        platformPostId: body.id,
        platformUrl: body.id ? `https://www.linkedin.com/feed/update/${body.id}` : undefined,
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
