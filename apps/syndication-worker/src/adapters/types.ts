import type { SocialPlatform } from '@digitalcanopy/syndication-core';

export interface DispatchRequest {
  tenantId: string;
  postId: string;
  connectionId: string;
  platform: SocialPlatform;
  text: string;
  linkUrl?: string;
  mediaUrls?: string[];
  threadChunks?: string[];
  credentials?: Record<string, unknown>;
}

export interface DispatchResult {
  success: boolean;
  platformPostId?: string;
  platformUrl?: string;
  statusCode?: number;
  retryable: boolean;
  error?: string;
}

export interface SocialAdapter {
  readonly platform: SocialPlatform;
  dispatch(request: DispatchRequest): Promise<DispatchResult>;
}
