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
 * Note: Does not check publication_posts so that failures occurring after
 * post creation but before feed_history recording can be safely retried.
 */
export async function isFeedItemProcessed(
  db: SyndicationDbClient,
  tenantId: string,
  itemGuid: string,
  feedUrl?: string,
): Promise<boolean> {
  let query = db
    .from('feed_history')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('item_guid', itemGuid);

  if (feedUrl) {
    query = query.eq('feed_url', feedUrl);
  }

  const { data, error } = await query.maybeSingle();

  if (error) {
    logger.error('Failed to check feed_history item', { tenantId, itemGuid, error: error.message });
    throw new Error(`Database error in isFeedItemProcessed: ${error.message}`);
  }

  return data !== null;
}

/**
 * Queries a publication post by source type and source reference ID.
 */
export async function getPublicationPostBySource(
  db: SyndicationDbClient,
  tenantId: string,
  sourceType: string,
  sourceRefId: string,
): Promise<PublicationPost | null> {
  const { data, error } = await db
    .from('publication_posts')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('source_type', sourceType)
    .eq('source_ref_id', sourceRefId)
    .maybeSingle();

  if (error) {
    logger.error('Failed to query publication post by source', {
      tenantId,
      sourceType,
      sourceRefId,
      error: error.message,
    });
    throw new Error(`Database error in getPublicationPostBySource: ${error.message}`);
  }

  return (data as PublicationPost) ?? null;
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

/**
 * Inserts pending channel dispatch records in `syndication.channel_dispatches`.
 */
export async function recordChannelDispatches(
  db: SyndicationDbClient,
  dispatches: Array<{
    id: string;
    tenant_id: string;
    post_id: string;
    channel_connection_id?: string;
    platform: string;
    status: string;
    idempotency_key: string;
    attempt: number;
  }>,
): Promise<void> {
  if (dispatches.length === 0) return;

  const { error } = await db.from('channel_dispatches').insert(dispatches);
  if (error) {
    logger.error('Failed to insert channel_dispatches records', { error: error.message });
    throw new Error(`Database error in recordChannelDispatches: ${error.message}`);
  }
}

/**
 * Queries an existing channel dispatch record by ID or idempotency key.
 */
export async function getChannelDispatch(
  db: SyndicationDbClient,
  params: {
    dispatchId?: string;
    tenantId: string;
    idempotencyKey?: string;
  },
): Promise<{
  id: string;
  status: string;
  platform_post_id?: string | null;
  platform_url?: string | null;
  attempt?: number;
  error_message?: string | null;
} | null> {
  let query = db
    .from('channel_dispatches')
    .select('id, status, platform_post_id, platform_url, attempt, error_message')
    .eq('tenant_id', params.tenantId);

  // Prefer stable post:channel idempotency_key over recreated dispatchId
  if (params.idempotencyKey) {
    query = query.eq('idempotency_key', params.idempotencyKey);
  } else if (params.dispatchId) {
    query = query.eq('id', params.dispatchId);
  } else {
    return null;
  }

  const { data, error } = await query.maybeSingle();

  if (error) {
    logger.error('Failed to query channel dispatch', { ...params, error: error.message });
    throw new Error(`Database error in getChannelDispatch: ${error.message}`);
  }

  return data ?? null;
}

/**
 * Updates atomic per-channel state in `syndication.channel_dispatches`.
 */
export async function updateChannelDispatch(
  db: SyndicationDbClient,
  params: {
    dispatchId: string;
    tenantId: string;
    idempotencyKey?: string;
    status: string;
    platformPostId?: string | null;
    platformUrl?: string | null;
    errorMessage?: string | null;
    attempt?: number;
    dispatchedAt?: string | null;
  },
): Promise<void> {
  const updates: Record<string, unknown> = {
    status: params.status,
  };
  if (params.platformPostId !== undefined) updates.platform_post_id = params.platformPostId;
  if (params.platformUrl !== undefined) updates.platform_url = params.platformUrl;
  if (params.errorMessage !== undefined) updates.error_message = params.errorMessage;
  if (params.attempt !== undefined) updates.attempt = params.attempt;
  if (params.dispatchedAt !== undefined) updates.dispatched_at = params.dispatchedAt;

  let query = db
    .from('channel_dispatches')
    .update(updates)
    .eq('tenant_id', params.tenantId);

  if (params.idempotencyKey) {
    query = query.eq('idempotency_key', params.idempotencyKey);
  } else {
    query = query.eq('id', params.dispatchId);
  }

  const { error } = await query;

  if (error) {
    logger.error('Failed to update channel dispatch', { dispatchId: params.dispatchId, error: error.message });
    throw new Error(`Database error in updateChannelDispatch: ${error.message}`);
  }
}

/**
 * Synchronizes publication post status based on the aggregate status of its channel dispatches.
 */
export async function syncPublicationPostStatus(
  db: SyndicationDbClient,
  postId: string,
  tenantId: string,
): Promise<string | null> {
  const { data: dispatches, error } = await db
    .from('channel_dispatches')
    .select('id, status')
    .eq('post_id', postId)
    .eq('tenant_id', tenantId);

  if (error) {
    logger.error('Failed to query channel dispatches for post status sync', { postId, error: error.message });
    throw new Error(`Database error in syncPublicationPostStatus: ${error.message}`);
  }

  if (!dispatches || dispatches.length === 0) {
    return null;
  }

  const allPublished = dispatches.every((d) => d.status === 'published');
  const allTerminal = dispatches.every((d) => ['published', 'failed', 'skipped'].includes(d.status));
  const anyPublished = dispatches.some((d) => d.status === 'published');
  const allFailed = dispatches.every((d) => d.status === 'failed');

  let targetStatus: string | null = null;
  let publishedAt: string | undefined = undefined;

  if (allPublished) {
    targetStatus = 'published';
    publishedAt = new Date().toISOString();
  } else if (allFailed) {
    targetStatus = 'failed';
  } else if (allTerminal) {
    targetStatus = anyPublished ? 'partial_failure' : 'failed';
  } else if (anyPublished) {
    targetStatus = 'publishing';
  }

  if (targetStatus) {
    const updatePayload: Record<string, unknown> = { status: targetStatus };
    if (publishedAt) {
      updatePayload.published_at = publishedAt;
    }
    const { error: updateErr } = await db
      .from('publication_posts')
      .update(updatePayload)
      .eq('id', postId)
      .eq('tenant_id', tenantId);

    if (updateErr) {
      logger.error('Failed to update publication post status', { postId, targetStatus, error: updateErr.message });
      throw new Error(`Database error in syncPublicationPostStatus: ${updateErr.message}`);
    }
  }

  return targetStatus;
}
