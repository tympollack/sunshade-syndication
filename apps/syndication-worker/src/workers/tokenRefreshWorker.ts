import type { SocialPlatform } from '@digitalcanopy/syndication-core';
import type { WorkerEnv } from '../types.js';
import { logger } from '../lib/logger.js';
import { getSyndicationDbClient, type SyndicationDbClient } from '../lib/supabase.js';

export const OAUTH_EXPIRY_HORIZON_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface ChannelConnectionRecord {
  id: string;
  tenant_id: string;
  platform: SocialPlatform;
  account_handle: string;
  account_urn?: string | null;
  status: string;
  token_expires_at: string | null;
  encrypted_credentials?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface RefreshTokenResult {
  success: boolean;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: string;
  isPermanentAuthFailure?: boolean;
  error?: string;
}

export type FetchFunction = typeof fetch;

export interface TokenRefreshDeps {
  db?: SyndicationDbClient;
  fetchFn?: FetchFunction;
  now?: () => Date;
  horizonMs?: number;
}

export interface TokenRefreshSummary {
  scanned: number;
  refreshed: number;
  expired: number;
  failed: number;
  skipped: number;
}

/**
 * Refreshes an expiring LinkedIn OAuth 2.0 access token using refresh_token grant.
 */
export async function refreshLinkedInOAuth(
  credentials: Record<string, unknown>,
  fetchFn: FetchFunction = fetch,
): Promise<RefreshTokenResult> {
  const refreshToken = String(credentials['refreshToken'] ?? '');
  const clientId = String(credentials['clientId'] ?? '');
  const clientSecret = String(credentials['clientSecret'] ?? '');

  if (!refreshToken || !clientId || !clientSecret) {
    return {
      success: false,
      isPermanentAuthFailure: true,
      error: 'Missing LinkedIn refreshToken, clientId, or clientSecret in credentials',
    };
  }

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  try {
    const res = await fetchFn('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!res.ok) {
      const isAuthErr = res.status === 400 || res.status === 401;
      return {
        success: false,
        isPermanentAuthFailure: isAuthErr,
        error: `LinkedIn token refresh HTTP ${res.status}`,
      };
    }

    const data = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
    };

    if (!data.access_token) {
      return { success: false, error: 'LinkedIn response omitted access_token' };
    }

    const expiresInSec = data.expires_in ?? 5184000; // default 60 days
    const tokenExpiresAt = new Date(Date.now() + expiresInSec * 1000).toISOString();

    return {
      success: true,
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
      tokenExpiresAt,
    };
  } catch (err) {
    return {
      success: false,
      isPermanentAuthFailure: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Refreshes an expiring X (Twitter) OAuth 2.0 user access token.
 */
export async function refreshXOAuth(
  credentials: Record<string, unknown>,
  fetchFn: FetchFunction = fetch,
): Promise<RefreshTokenResult> {
  const refreshToken = String(credentials['refreshToken'] ?? '');
  const clientId = String(credentials['clientId'] ?? '');
  const clientSecret = String(credentials['clientSecret'] ?? '');

  if (!refreshToken || !clientId) {
    return {
      success: false,
      isPermanentAuthFailure: true,
      error: 'Missing X refreshToken or clientId in credentials',
    };
  }

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  if (clientSecret) {
    const basicAuth = btoa(`${clientId}:${clientSecret}`);
    headers['Authorization'] = `Basic ${basicAuth}`;
  }

  try {
    const res = await fetchFn('https://api.twitter.com/2/oauth2/token', {
      method: 'POST',
      headers,
      body: params.toString(),
    });

    if (!res.ok) {
      const isAuthErr = res.status === 400 || res.status === 401;
      return {
        success: false,
        isPermanentAuthFailure: isAuthErr,
        error: `X token refresh HTTP ${res.status}`,
      };
    }

    const data = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
    };

    if (!data.access_token) {
      return { success: false, error: 'X response omitted access_token' };
    }

    const expiresInSec = data.expires_in ?? 7200; // default 2 hours
    const tokenExpiresAt = new Date(Date.now() + expiresInSec * 1000).toISOString();

    return {
      success: true,
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
      tokenExpiresAt,
    };
  } catch (err) {
    return {
      success: false,
      isPermanentAuthFailure: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Exchanges a short/expiring Meta Graph User access token for a 60-day long-lived token.
 */
export async function refreshMetaOAuth(
  credentials: Record<string, unknown>,
  fetchFn: FetchFunction = fetch,
): Promise<RefreshTokenResult> {
  const accessToken = String(credentials['pageAccessToken'] ?? credentials['accessToken'] ?? '');
  const clientId = String(credentials['clientId'] ?? '');
  const clientSecret = String(credentials['clientSecret'] ?? '');

  if (!accessToken || !clientId || !clientSecret) {
    return {
      success: false,
      isPermanentAuthFailure: true,
      error: 'Missing Meta accessToken, clientId, or clientSecret in credentials',
    };
  }

  const url = new URL('https://graph.facebook.com/v21.0/oauth/access_token');
  url.searchParams.set('grant_type', 'fb_exchange_token');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('client_secret', clientSecret);
  url.searchParams.set('fb_exchange_token', accessToken);

  try {
    const res = await fetchFn(url.toString(), { method: 'GET' });

    if (!res.ok) {
      const isAuthErr = res.status === 400 || res.status === 401;
      return {
        success: false,
        isPermanentAuthFailure: isAuthErr,
        error: `Meta token refresh HTTP ${res.status}`,
      };
    }

    const data = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
    };

    if (!data.access_token) {
      return { success: false, error: 'Meta response omitted access_token' };
    }

    const expiresInSec = data.expires_in ?? 5184000; // default 60 days
    const tokenExpiresAt = new Date(Date.now() + expiresInSec * 1000).toISOString();

    return {
      success: true,
      accessToken: data.access_token,
      tokenExpiresAt,
    };
  } catch (err) {
    return {
      success: false,
      isPermanentAuthFailure: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Refreshes an AT Protocol / Bluesky session using `com.atproto.server.refreshSession`.
 */
export async function refreshBlueskySession(
  credentials: Record<string, unknown>,
  fetchFn: FetchFunction = fetch,
): Promise<RefreshTokenResult> {
  const pdsUrl = String(credentials['service'] ?? 'https://bsky.social');
  const refreshJwt = String(credentials['refreshJwt'] ?? '');

  if (!refreshJwt) {
    return {
      success: false,
      isPermanentAuthFailure: true,
      error: 'Missing Bluesky refreshJwt in credentials',
    };
  }

  try {
    const res = await fetchFn(`${pdsUrl}/xrpc/com.atproto.server.refreshSession`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${refreshJwt}`,
      },
    });

    if (!res.ok) {
      const isAuthErr = res.status === 400 || res.status === 401;
      return {
        success: false,
        isPermanentAuthFailure: isAuthErr,
        error: `Bluesky session refresh HTTP ${res.status}`,
      };
    }

    const data = (await res.json()) as {
      accessJwt?: string;
      refreshJwt?: string;
    };

    if (!data.accessJwt) {
      return { success: false, error: 'Bluesky response omitted accessJwt' };
    }

    const tokenExpiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

    return {
      success: true,
      accessToken: data.accessJwt,
      refreshToken: data.refreshJwt ?? refreshJwt,
      tokenExpiresAt,
    };
  } catch (err) {
    return {
      success: false,
      isPermanentAuthFailure: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Dispatches refresh token requests to the appropriate platform handler.
 */
export async function dispatchTokenRefresh(
  platform: SocialPlatform,
  credentials: Record<string, unknown>,
  fetchFn: FetchFunction = fetch,
): Promise<RefreshTokenResult> {
  switch (platform) {
    case 'linkedin':
      return refreshLinkedInOAuth(credentials, fetchFn);
    case 'x':
      return refreshXOAuth(credentials, fetchFn);
    case 'meta':
      return refreshMetaOAuth(credentials, fetchFn);
    case 'bluesky':
      return refreshBlueskySession(credentials, fetchFn);
    default:
      return {
        success: false,
        isPermanentAuthFailure: false,
        error: `No OAuth refresh handler implemented for platform: ${platform}`,
      };
  }
}

/**
 * Daily OAuth token expiry scanner (`0 6 * * *`).
 * Scans `syndication.channel_connections` for active connections expiring
 * within 7 days (`token_expires_at <= now() + 7 days`) and refreshes them.
 */
export async function handleTokenRefreshCron(
  env: WorkerEnv,
  deps: TokenRefreshDeps = {},
): Promise<TokenRefreshSummary> {
  const summary: TokenRefreshSummary = {
    scanned: 0,
    refreshed: 0,
    expired: 0,
    failed: 0,
    skipped: 0,
  };

  const db = deps.db ?? (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY ? getSyndicationDbClient(env) : undefined);
  if (!db) {
    logger.info('Token refresh scanner skipped: database client not configured');
    return summary;
  }

  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ? deps.now() : new Date();
  const horizonMs = deps.horizonMs ?? OAUTH_EXPIRY_HORIZON_MS;
  const cutoffIso = new Date(now.getTime() + horizonMs).toISOString();

  // Query active channel connections expiring on or before the horizon
  const { data, error } = await db
    .from('channel_connections')
    .select('id, tenant_id, platform, account_handle, account_urn, status, token_expires_at, encrypted_credentials, metadata')
    .eq('status', 'active')
    .not('token_expires_at', 'is', null)
    .lte('token_expires_at', cutoffIso);

  if (error) {
    logger.error('Failed to scan expiring OAuth tokens', { error: error.message });
    throw new Error(`Database error in handleTokenRefreshCron: ${error.message}`);
  }

  const expiringConnections = (data ?? []) as ChannelConnectionRecord[];
  summary.scanned = expiringConnections.length;

  logger.info('Commencing OAuth token expiry refresh cycle', {
    scannedCount: summary.scanned,
    cutoffIso,
  });

  for (const conn of expiringConnections) {
    const creds = conn.encrypted_credentials ?? {};
    if (Object.keys(creds).length === 0) {
      summary.skipped += 1;
      logger.warn('Skipping channel connection refresh: no credentials stored in record', {
        connectionId: conn.id,
        platform: conn.platform,
        accountHandle: conn.account_handle,
      });
      continue;
    }

    const refreshResult = await dispatchTokenRefresh(conn.platform, creds, fetchFn);

    if (refreshResult.success && refreshResult.accessToken && refreshResult.tokenExpiresAt) {
      const updatedCredentials = {
        ...creds,
        accessToken: refreshResult.accessToken,
        ...(refreshResult.refreshToken ? { refreshToken: refreshResult.refreshToken } : {}),
        ...(conn.platform === 'meta' ? { pageAccessToken: refreshResult.accessToken } : {}),
      };

      const { error: updateErr } = await db
        .from('channel_connections')
        .update({
          token_expires_at: refreshResult.tokenExpiresAt,
          encrypted_credentials: updatedCredentials,
          status: 'active',
        })
        .eq('id', conn.id)
        .eq('tenant_id', conn.tenant_id);

      if (updateErr) {
        summary.failed += 1;
        logger.error('Failed to update refreshed credentials in database', {
          connectionId: conn.id,
          platform: conn.platform,
          error: updateErr.message,
        });
      } else {
        summary.refreshed += 1;
        logger.info('Successfully refreshed OAuth token for connection', {
          connectionId: conn.id,
          platform: conn.platform,
          accountHandle: conn.account_handle,
          newTokenExpiresAt: refreshResult.tokenExpiresAt,
        });
      }
      continue;
    }

    if (refreshResult.isPermanentAuthFailure) {
      summary.expired += 1;
      const { error: expireErr } = await db
        .from('channel_connections')
        .update({ status: 'expired' })
        .eq('id', conn.id)
        .eq('tenant_id', conn.tenant_id);

      if (expireErr) {
        logger.error('Failed to mark connection expired', {
          connectionId: conn.id,
          error: expireErr.message,
        });
      }

      logger.warn('OAuth refresh token rejected permanently; marked connection expired', {
        connectionId: conn.id,
        platform: conn.platform,
        accountHandle: conn.account_handle,
        reason: refreshResult.error,
      });
      continue;
    }

    // Transient failure (network/5xx) — keep active, will retry on next cron
    summary.failed += 1;
    logger.error('Transient failure during OAuth refresh; will retry on next cycle', {
      connectionId: conn.id,
      platform: conn.platform,
      accountHandle: conn.account_handle,
      error: refreshResult.error,
    });
  }

  logger.info('Completed OAuth token expiry refresh cycle', {
    ...summary,
    cutoffIso,
  });

  return summary;
}
