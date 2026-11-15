import type { DispatchRequest, DispatchResult, SocialAdapter } from './types.js';

export interface MetaGraphAdapterOptions {
  fetchFn?: typeof fetch;
  apiVersion?: string;
}

export const META_DEFAULT_API_VERSION = 'v21.0';
export const META_MIN_SCHEDULE_SECONDS = 600; // 10 minutes in future
export const META_MAX_SCHEDULE_SECONDS = 75 * 24 * 60 * 60; // 75 days

/**
 * Meta Graph API outbound adapter.
 * Publishes posts to Facebook Pages via `POST /{page-id}/feed` with link previews,
 * attached cover media, and scheduled publication support.
 */
export class MetaGraphAdapter implements SocialAdapter {
  readonly platform = 'meta' as const;
  private readonly fetchFn: typeof fetch;
  private readonly apiVersion: string;

  constructor(options: MetaGraphAdapterOptions = {}) {
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.apiVersion = options.apiVersion ?? META_DEFAULT_API_VERSION;
  }

  async dispatch(
    request: DispatchRequest,
    overrideOptions?: MetaGraphAdapterOptions,
  ): Promise<DispatchResult> {
    const fetchFn = overrideOptions?.fetchFn ?? this.fetchFn;
    const apiVersion = overrideOptions?.apiVersion ?? this.apiVersion;

    const pageId = String(request.credentials?.['pageId'] ?? 'me');
    const token = String(
      request.credentials?.['pageAccessToken'] ?? request.credentials?.['accessToken'] ?? '',
    );

    // 1. Stub / Mock mode when no credentials provided
    if (!token) {
      const mockPostId = `${pageId}_stub-${Date.now()}`;
      return {
        success: true,
        platformPostId: mockPostId,
        platformUrl: `https://facebook.com/${mockPostId}`,
        statusCode: 200,
        retryable: false,
      };
    }

    try {
      const params = new URLSearchParams({
        message: request.text,
        access_token: token,
      });

      // 2. Link Preview
      if (request.linkUrl) {
        params.set('link', request.linkUrl);
      }

      // 3. Scheduled Post Handling
      const scheduledAtInput =
        request.scheduledAt ??
        (request.credentials?.['scheduledAt'] as string | undefined) ??
        (request.credentials?.['scheduledPublishTime'] as string | number | undefined);

      if (scheduledAtInput) {
        const scheduledTimeMs =
          typeof scheduledAtInput === 'number'
            ? scheduledAtInput * 1000
            : new Date(scheduledAtInput).getTime();

        const nowMs = Date.now();
        const diffSeconds = Math.floor((scheduledTimeMs - nowMs) / 1000);

        if (diffSeconds < META_MIN_SCHEDULE_SECONDS) {
          return {
            success: false,
            retryable: false,
            error: `Meta scheduled_publish_time must be at least 10 minutes in the future (requested ${diffSeconds}s ahead).`,
          };
        }

        if (diffSeconds > META_MAX_SCHEDULE_SECONDS) {
          return {
            success: false,
            retryable: false,
            error: `Meta scheduled_publish_time cannot be more than 75 days in the future (requested ${diffSeconds}s ahead).`,
          };
        }

        const scheduledUnix = Math.floor(scheduledTimeMs / 1000);
        params.set('published', 'false');
        params.set('scheduled_publish_time', String(scheduledUnix));
      }

      // 4. Cover Media / Photos Handling via attached_media
      if (request.mediaUrls && request.mediaUrls.length > 0) {
        const attachedMedia: Array<{ media_fbid: string }> = [];

        for (let i = 0; i < request.mediaUrls.length; i++) {
          const mediaUrl = request.mediaUrls[i]!;

          // Upload photo to page un-published to get media_fbid
          const photoParams = new URLSearchParams({
            url: mediaUrl,
            published: 'false',
            access_token: token,
          });

          const photoRes = await fetchFn(
            `https://graph.facebook.com/${apiVersion}/${pageId}/photos`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: photoParams.toString(),
            },
          );

          if (!photoRes.ok) {
            const status = photoRes.status;
            return {
              success: false,
              statusCode: status,
              retryable: status === 429 || status >= 500,
              error: `Meta photo upload returned HTTP ${status} for ${mediaUrl}`,
            };
          }

          const photoData = (await photoRes.json()) as { id?: string };
          if (!photoData.id) {
            return {
              success: false,
              retryable: false,
              error: 'Meta photo upload response omitted photo ID',
            };
          }

          attachedMedia.push({ media_fbid: photoData.id });
        }

        params.set('attached_media', JSON.stringify(attachedMedia));
      }

      // 5. Publish to /{page-id}/feed
      const response = await fetchFn(`https://graph.facebook.com/${apiVersion}/${pageId}/feed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });

      if (!response.ok) {
        const status = response.status;
        return {
          success: false,
          statusCode: status,
          // 429 rate limit or 5xx is retryable; 401/403 are permanent auth/client errors
          retryable: status === 429 || status >= 500,
          error: `Meta Graph API returned HTTP ${status}`,
        };
      }

      const body = (await response.json()) as { id?: string };
      const platformPostId = body.id;
      const platformUrl = platformPostId ? `https://facebook.com/${platformPostId}` : undefined;

      return {
        success: true,
        platformPostId,
        platformUrl,
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
