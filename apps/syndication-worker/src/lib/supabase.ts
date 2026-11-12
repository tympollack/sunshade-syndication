import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  ChannelConnection,
  FeedHistory,
  PublicationPost,
  SocialPlatform,
} from '@digitalcanopy/syndication-core';
import type { WorkerEnv } from '../types.js';
import { logger } from './logger.js';

export type SyndicationDbClient = SupabaseClient<any, any, any>;

/**
 * Creates a Supabase client scoped to the `syndication` schema.
 * All mutations and queries enforce strict `{ data, error }` checks.
 */
export function getSyndicationDbClient(env: WorkerEnv): SyndicationDbClient {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.');
  }

  return createClient(url, key, {
    db: { schema: 'syndication' },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Queries active channel connections for a given tenant.
 */
export async function getActiveChannelConnections(
  db: SyndicationDbClient,
  tenantId: string,
  platform?: SocialPlatform,
): Promise<ChannelConnection[]> {
  let query = db
    .from('channel_connections')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('status', 'active');

  if (platform) {
    query = query.eq('platform', platform);
  }

  const { data, error } = await query;
  if (error) {
    logger.error('Failed to query active channel connections', { tenantId, error: error.message });
    throw new Error(`Database error in getActiveChannelConnections: ${error.message}`);
  }

  return (data ?? []) as ChannelConnection[];
}

/**
 * Checks if an RSS item GUID has already been processed in feed_history.
 */
export async function isFeedItemProcessed(
  db: SyndicationDbClient,
  tenantId: string,
  itemGuid: string,
): Promise<boolean> {
  const { data, error } = await db
    .from('feed_history')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('item_guid', itemGuid)
    .maybeSingle();

  if (error) {
    logger.error('Failed to check feed_history item', { tenantId, itemGuid, error: error.message });
    throw new Error(`Database error in isFeedItemProcessed: ${error.message}`);
  }

  return data !== null;
}

/**
 * Records an RSS item into `feed_history` to prevent duplicate syndications.
 */
export async function recordFeedHistory(
  db: SyndicationDbClient,
  entry: {
    tenant_id: string;
    feed_url: string;
    item_guid: string;
    item_url: string;
    title: string;
    published_at: string;
    publication_post_id?: string;
  },
): Promise<FeedHistory> {
  const { data, error } = await db
    .from('feed_history')
    .insert(entry)
    .select('*')
    .single();

  if (error) {
    logger.error('Failed to insert feed_history record', {
      tenantId: entry.tenant_id,
      itemGuid: entry.item_guid,
      error: error.message,
    });
    throw new Error(`Database error in recordFeedHistory: ${error.message}`);
  }

  return data as FeedHistory;
}

/**
 * Creates a publication post record with explicit error destructuring.
 */
export async function createPublicationPost(
  db: SyndicationDbClient,
  post: {
    tenant_id: string;
    source_type: string;
    source_ref_id: string;
    title: string;
    body: string;
    canonical_url: string;
    short_url?: string;
    media_urls?: string[];
    status?: string;
  },
): Promise<PublicationPost> {
  const { data, error } = await db
    .from('publication_posts')
    .insert({
      ...post,
      status: post.status ?? 'queued',
      media_urls: post.media_urls ?? [],
    })
    .select('*')
    .single();

  if (error) {
    logger.error('Failed to insert publication post', {
      tenantId: post.tenant_id,
      sourceRefId: post.source_ref_id,
      error: error.message,
    });
    throw new Error(`Database error in createPublicationPost: ${error.message}`);
  }

  return data as PublicationPost;
}
