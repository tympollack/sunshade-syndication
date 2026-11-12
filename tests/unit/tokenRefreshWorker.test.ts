import { describe, expect, it, vi } from 'vitest';
import type { SocialPlatform } from '@digitalcanopy/syndication-core';
import {
  handleTokenRefreshCron,
  refreshBlueskySession,
  refreshLinkedInOAuth,
  refreshMetaOAuth,
  refreshXOAuth,
  type ChannelConnectionRecord,
  type FetchFunction,
} from '../../apps/syndication-worker/src/workers/tokenRefreshWorker.js';

describe('tokenRefreshWorker', () => {
  describe('platform refresh routines', () => {
    it('successfully refreshes LinkedIn OAuth tokens and computes new expiry', async () => {
      const mockFetch: FetchFunction = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: 'new-li-access-token-12345',
            expires_in: 5184000,
            refresh_token: 'new-li-refresh-token-67890',
          }),
          { status: 200 },
        ),
      );

      const result = await refreshLinkedInOAuth(
        {
          refreshToken: 'old-refresh-token',
          clientId: 'li-client-id',
          clientSecret: 'li-client-secret',
        },
        mockFetch,
      );

      expect(result.success).toBe(true);
      expect(result.accessToken).toBe('new-li-access-token-12345');
      expect(result.refreshToken).toBe('new-li-refresh-token-67890');
      expect(result.tokenExpiresAt).toBeDefined();
      expect(result.isPermanentAuthFailure).toBeUndefined();
    });

    it('identifies permanent LinkedIn auth failures (HTTP 401)', async () => {
      const mockFetch: FetchFunction = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: 'invalid_grant', error_description: 'Refresh token revoked' }),
          { status: 401 },
        ),
      );

      const result = await refreshLinkedInOAuth(
        {
          refreshToken: 'revoked-refresh-token',
          clientId: 'li-client-id',
          clientSecret: 'li-client-secret',
        },
        mockFetch,
      );

      expect(result.success).toBe(false);
      expect(result.isPermanentAuthFailure).toBe(true);
      expect(result.error).toContain('401');
    });

    it('successfully refreshes X (Twitter) OAuth 2.0 tokens', async () => {
      const mockFetch: FetchFunction = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: 'new-x-access-token',
            expires_in: 7200,
            refresh_token: 'new-x-refresh-token',
          }),
          { status: 200 },
        ),
      );

      const result = await refreshXOAuth(
        {
          refreshToken: 'old-x-refresh',
          clientId: 'x-client-id',
          clientSecret: 'x-client-secret',
        },
        mockFetch,
      );

      expect(result.success).toBe(true);
      expect(result.accessToken).toBe('new-x-access-token');
      expect(result.tokenExpiresAt).toBeDefined();
    });

    it('successfully exchanges Meta Graph access tokens for long-lived tokens', async () => {
      const mockFetch: FetchFunction = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: 'long-lived-meta-token-xyz',
            expires_in: 5184000,
          }),
          { status: 200 },
        ),
      );

      const result = await refreshMetaOAuth(
        {
          pageAccessToken: 'short-lived-page-token',
          clientId: 'meta-client-id',
          clientSecret: 'meta-client-secret',
        },
        mockFetch,
      );

      expect(result.success).toBe(true);
      expect(result.accessToken).toBe('long-lived-meta-token-xyz');
    });

    it('successfully refreshes Bluesky AT Protocol session', async () => {
      const mockFetch: FetchFunction = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            accessJwt: 'new-access-jwt-atproto',
            refreshJwt: 'new-refresh-jwt-atproto',
          }),
          { status: 200 },
        ),
      );

      const result = await refreshBlueskySession(
        {
          service: 'https://bsky.social',
          refreshJwt: 'old-refresh-jwt',
        },
        mockFetch,
      );

      expect(result.success).toBe(true);
      expect(result.accessToken).toBe('new-access-jwt-atproto');
      expect(result.refreshToken).toBe('new-refresh-jwt-atproto');
    });
  });

  describe('handleTokenRefreshCron scanner & lifecycle transitions', () => {
    it('scans expiring channels within 7-day horizon and isolates failures', async () => {
      const now = new Date('2026-11-12T12:00:00.000Z');

      const mockConnections: ChannelConnectionRecord[] = [
        {
          id: 'c-li-1',
          tenant_id: 't-1',
          platform: 'linkedin',
          account_handle: 'sunshade-systems',
          status: 'active',
          token_expires_at: new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString(), // expires in 3 days (within 7d)
          encrypted_credentials: {
            refreshToken: 'valid-li-refresh',
            clientId: 'cid',
            clientSecret: 'csec',
          },
        },
        {
          id: 'c-x-revoked',
          tenant_id: 't-1',
          platform: 'x',
          account_handle: '@SunShadeSystems',
          status: 'active',
          token_expires_at: new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000).toISOString(), // expires in 1 day
          encrypted_credentials: {
            refreshToken: 'revoked-x-refresh',
            clientId: 'x-cid',
          },
        },
        {
          id: 'c-meta-1',
          tenant_id: 't-1',
          platform: 'meta',
          account_handle: 'SunShadeFacebook',
          status: 'active',
          token_expires_at: new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000).toISOString(), // expires in 5 days
          encrypted_credentials: {
            pageAccessToken: 'valid-meta-token',
            clientId: 'meta-cid',
            clientSecret: 'meta-csec',
          },
        },
      ];

      const updatedRecords: Array<{ id: string; status?: string; token_expires_at?: string }> = [];

      // Mock Supabase DB Client
      const mockDb: any = {
        from: (table: string) => {
          expect(table).toBe('channel_connections');
          return {
            select: () => ({
              eq: (field: string, val: string) => ({
                not: () => ({
                  lte: () => Promise.resolve({ data: mockConnections, error: null }),
                }),
              }),
            }),
            update: (payload: Record<string, unknown>) => ({
              eq: (fieldA: string, id: string) => ({
                eq: (fieldB: string, tenantId: string) => {
                  updatedRecords.push({ id, ...payload });
                  return Promise.resolve({ error: null });
                },
              }),
            }),
          };
        },
      };

      // Mock Fetch function:
      // LinkedIn -> 200 OK
      // X -> 401 Unauthorized (permanent failure)
      // Meta -> 200 OK
      const mockFetch: FetchFunction = vi.fn().mockImplementation((url: string | URL | Request) => {
        const urlStr = url.toString();
        if (urlStr.includes('linkedin.com')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                access_token: 'refreshed-li-token',
                expires_in: 5184000,
              }),
              { status: 200 },
            ),
          );
        }
        if (urlStr.includes('twitter.com')) {
          return Promise.resolve(
            new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 401 }),
          );
        }
        if (urlStr.includes('facebook.com')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                access_token: 'refreshed-meta-token',
                expires_in: 5184000,
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.reject(new Error(`Unexpected fetch URL: ${urlStr}`));
      });

      const summary = await handleTokenRefreshCron(
        {},
        {
          db: mockDb,
          fetchFn: mockFetch,
          now: () => now,
        },
      );

      expect(summary.scanned).toBe(3);
      expect(summary.refreshed).toBe(2);
      expect(summary.expired).toBe(1);
      expect(summary.failed).toBe(0);

      // Verify LinkedIn was refreshed and kept active
      const liUpdate = updatedRecords.find((r) => r.id === 'c-li-1');
      expect(liUpdate?.status).toBe('active');
      expect(liUpdate?.token_expires_at).toBeDefined();

      // Verify X failed permanently and was marked 'expired'
      const xUpdate = updatedRecords.find((r) => r.id === 'c-x-revoked');
      expect(xUpdate?.status).toBe('expired');

      // Verify Meta succeeded despite X failing (fault isolation)
      const metaUpdate = updatedRecords.find((r) => r.id === 'c-meta-1');
      expect(metaUpdate?.status).toBe('active');
    });
  });
});
