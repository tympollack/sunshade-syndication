import type { DispatchRequest, DispatchResult, SocialAdapter } from './types.js';

export interface LinkedInAdapterOptions {
  fetchFn?: typeof fetch;
}

export interface LinkedInMediaUploadItem {
  status: 'READY';
  media?: string;
  originalUrl?: string;
  title?: { text: string };
  description?: { text: string };
}

export const LINKEDIN_URN_REGEX = /^urn:li:(person|organization|organizationBrand):[a-zA-Z0-9_-]+$/;

/**
 * LinkedIn Community REST v2 outbound social adapter.
 * Supports personal profiles (`urn:li:person:...`) and organization pages (`urn:li:organization:...`),
 * uploads image assets via registerUpload / initializeUpload, and creates `com.linkedin.ugc.ShareContent` posts.
 */
export class LinkedInAdapter implements SocialAdapter {
  readonly platform = 'linkedin' as const;
  private readonly fetchFn: typeof fetch;

  constructor(options: LinkedInAdapterOptions = {}) {
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  async dispatch(
    request: DispatchRequest,
    overrideOptions?: LinkedInAdapterOptions,
  ): Promise<DispatchResult> {
    const fetchFn = overrideOptions?.fetchFn ?? this.fetchFn;

    // 1. Stub / Mock mode when no credentials provided
    if (!request.credentials || !request.credentials['accessToken']) {
      const mockId = `urn:li:share:stub-${Date.now().toString(36)}`;
      return {
        success: true,
        platformPostId: mockId,
        platformUrl: `https://www.linkedin.com/feed/update/${mockId}`,
        statusCode: 200,
        retryable: false,
      };
    }

    try {
      const accessToken = String(request.credentials['accessToken']);
      const rawAuthorUrn = String(
        request.credentials['authorUrn'] ??
          request.credentials['accountUrn'] ??
          request.credentials['organizationUrn'] ??
          request.credentials['personUrn'] ??
          '',
      ).trim();

      const authorUrn = rawAuthorUrn || 'urn:li:person:mock-person-urn';

      if (!LINKEDIN_URN_REGEX.test(authorUrn)) {
        return {
          success: false,
          retryable: false,
          error: `Invalid LinkedIn author URN '${authorUrn}'. Must match format urn:li:person:... or urn:li:organization:...`,
        };
      }

      let shareMediaCategory: 'NONE' | 'ARTICLE' | 'IMAGE' = 'NONE';
      const mediaList: LinkedInMediaUploadItem[] = [];

      // 2. Handle Media Asset Uploads (initializeUpload / registerUpload)
      if (request.mediaUrls && request.mediaUrls.length > 0) {
        shareMediaCategory = 'IMAGE';
        const imageTitles = (request.credentials['imageTitles'] as string[]) ?? [];

        for (let i = 0; i < request.mediaUrls.length; i++) {
          const mediaUrl = request.mediaUrls[i]!;

          // Download media binary
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

          // Register upload asset with LinkedIn
          const registerPayload = {
            registerUploadRequest: {
              recipes: ['urn:li:digitalmediaRecipe:feedshare-image'],
              owner: authorUrn,
              serviceRelationships: [
                {
                  relationshipType: 'OWNER',
                  identifier: 'urn:li:userGeneratedContent',
                },
              ],
            },
          };

          const registerRes = await fetchFn('https://api.linkedin.com/v2/assets?action=registerUpload', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Restli-Protocol-Version': '2.0.0',
              Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify(registerPayload),
          });

          if (!registerRes.ok) {
            const status = registerRes.status;
            return {
              success: false,
              statusCode: status,
              retryable: status === 429 || status >= 500,
              error: `LinkedIn registerUpload returned HTTP ${status}`,
            };
          }

          const registerData = (await registerRes.json()) as {
            value?: {
              asset?: string;
              uploadMechanism?: {
                'com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest'?: {
                  uploadUrl?: string;
                  headers?: Record<string, string>;
                };
              };
            };
          };

          const assetUrn = registerData.value?.asset;
          const uploadHttpRequest =
            registerData.value?.uploadMechanism?.['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest'];
          const uploadUrl = uploadHttpRequest?.uploadUrl;

          if (!assetUrn || !uploadUrl) {
            return {
              success: false,
              retryable: false,
              error: 'LinkedIn registerUpload response omitted asset URN or uploadUrl',
            };
          }

          // Upload image binary payload to uploadUrl
          const uploadHeaders: Record<string, string> = {
            'Content-Type': contentType,
            ...(uploadHttpRequest.headers ?? {}),
          };

          const uploadRes = await fetchFn(uploadUrl, {
            method: 'PUT',
            headers: uploadHeaders,
            body: arrayBuffer,
          });

          if (!uploadRes.ok) {
            const status = uploadRes.status;
            return {
              success: false,
              statusCode: status,
              retryable: status === 429 || status >= 500,
              error: `LinkedIn binary media upload returned HTTP ${status}`,
            };
          }

          mediaList.push({
            status: 'READY',
            media: assetUrn,
            title: imageTitles[i] ? { text: imageTitles[i]! } : undefined,
          });
        }
      } else if (request.linkUrl) {
        shareMediaCategory = 'ARTICLE';
        mediaList.push({
          status: 'READY',
          originalUrl: request.linkUrl,
          title: request.credentials['linkTitle']
            ? { text: String(request.credentials['linkTitle']) }
            : undefined,
          description: request.credentials['linkDescription']
            ? { text: String(request.credentials['linkDescription']) }
            : undefined,
        });
      }

      // 3. Construct UGC Post Request
      const shareContent: Record<string, unknown> = {
        shareCommentary: { text: request.text },
        shareMediaCategory,
      };

      if (mediaList.length > 0) {
        shareContent['media'] = mediaList;
      }

      const postPayload = {
        author: authorUrn,
        lifecycleState: 'PUBLISHED',
        specificContent: {
          'com.linkedin.ugc.ShareContent': shareContent,
        },
        visibility: {
          'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
        },
      };

      const response = await fetchFn('https://api.linkedin.com/v2/ugcPosts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Restli-Protocol-Version': '2.0.0',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(postPayload),
      });

      if (!response.ok) {
        const status = response.status;
        return {
          success: false,
          statusCode: status,
          // 429 rate limit or 5xx is retryable; 401/403/422 are non-retryable
          retryable: status === 429 || status >= 500,
          error: `LinkedIn API error HTTP ${status}`,
        };
      }

      const body = (await response.json()) as { id?: string };
      const platformPostId = body.id;
      const platformUrl = platformPostId
        ? `https://www.linkedin.com/feed/update/${platformPostId}`
        : undefined;

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
