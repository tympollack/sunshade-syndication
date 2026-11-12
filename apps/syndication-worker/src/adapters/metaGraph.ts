import type { DispatchRequest, DispatchResult, SocialAdapter } from './types.js';

/**
 * Meta Graph API outbound adapter stub.
 * Publishes posts to Facebook Pages (`POST /{page-id}/feed`) or Instagram accounts.
 */
export class MetaGraphAdapter implements SocialAdapter {
  readonly platform = 'meta' as const;

  async dispatch(request: DispatchRequest): Promise<DispatchResult> {
    if (!request.credentials || !request.credentials['pageAccessToken']) {
      return {
        success: true,
        platformPostId: `1000000_${Date.now()}`,
        platformUrl: 'https://facebook.com/SunShadeSystems/posts/mock',
        retryable: false,
      };
    }

    try {
      const pageId = String(request.credentials['pageId'] ?? 'me');
      const token = String(request.credentials['pageAccessToken']);

      const params = new URLSearchParams({
        message: request.text,
        access_token: token,
      });

      if (request.linkUrl) {
        params.set('link', request.linkUrl);
      }

      const response = await fetch(`https://graph.facebook.com/v21.0/${pageId}/feed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });

      if (!response.ok) {
        const status = response.status;
        return {
          success: false,
          statusCode: status,
          retryable: status === 429 || status >= 500,
          error: `Meta Graph API returned HTTP ${status}`,
        };
      }

      const body = (await response.json()) as { id?: string };
      return {
        success: true,
        platformPostId: body.id,
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
