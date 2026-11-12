import type { WorkerEnv } from '../types.js';
import { logger } from '../lib/logger.js';
import { getSyndicationDbClient } from '../lib/supabase.js';

/**
 * Daily OAuth token expiry scanner stub (`0 6 * * *`).
 * Queries `syndication.channel_connections` expiring within 48 hours and flags/refreshes them.
 */
export async function handleTokenRefreshCron(env: WorkerEnv): Promise<void> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    logger.info('Token refresh scanner skipped: Supabase credentials not configured');
    return;
  }

  const db = getSyndicationDbClient(env);
  const cutoffIso = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

  const { data, error } = await db
    .from('channel_connections')
    .select('id, tenant_id, platform, account_handle, token_expires_at')
    .eq('status', 'active')
    .not('token_expires_at', 'is', null)
    .lte('token_expires_at', cutoffIso);

  if (error) {
    logger.error('Failed to scan expiring OAuth tokens', { error: error.message });
    throw new Error(`Database error in handleTokenRefreshCron: ${error.message}`);
  }

  const expiring = data ?? [];
  logger.info('Completed daily OAuth token expiry scan', {
    expiringCount: expiring.length,
    cutoffIso,
  });

  // Future implementation: invoke OAuth refresh grant per platform using pgsodium RPCs.
}
