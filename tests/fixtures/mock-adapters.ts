import type { SocialPlatform } from '@digitalcanopy/syndication-core';
import type {
  DispatchRequest,
  DispatchResult,
  SocialAdapter,
} from '../../apps/syndication-worker/src/adapters/types.js';

export interface MockAdapterSpy extends SocialAdapter {
  readonly calls: DispatchRequest[];
}

export function createSuccessMockAdapter(platform: SocialPlatform): MockAdapterSpy {
  const calls: DispatchRequest[] = [];
  return {
    platform,
    calls,
    async dispatch(request: DispatchRequest): Promise<DispatchResult> {
      calls.push(request);
      return {
        success: true,
        platformPostId: `${platform}-post-${calls.length}`,
        platformUrl: `https://example.invalid/${platform}/${calls.length}`,
        statusCode: 200,
        retryable: false,
      };
    },
  };
}

export function createRateLimited429MockAdapter(platform: SocialPlatform): MockAdapterSpy {
  const calls: DispatchRequest[] = [];
  return {
    platform,
    calls,
    async dispatch(request: DispatchRequest): Promise<DispatchResult> {
      calls.push(request);
      return {
        success: false,
        statusCode: 429,
        retryable: true,
        error: `${platform} rate limit exceeded (HTTP 429)`,
      };
    },
  };
}

export function createUnauthorized401MockAdapter(platform: SocialPlatform): MockAdapterSpy {
  const calls: DispatchRequest[] = [];
  return {
    platform,
    calls,
    async dispatch(request: DispatchRequest): Promise<DispatchResult> {
      calls.push(request);
      return {
        success: false,
        statusCode: 401,
        retryable: false,
        error: `${platform} OAuth token rejected (HTTP 401)`,
      };
    },
  };
}
