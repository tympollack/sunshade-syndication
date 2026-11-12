import { z } from 'zod';

/**
 * Supported outbound social publishing platforms.
 */
export const SocialPlatformSchema = z.enum(['bluesky', 'linkedin', 'x', 'meta']);
export type SocialPlatform = z.infer<typeof SocialPlatformSchema>;

/**
 * Connection lifecycle states for `syndication.channel_connections`.
 */
export const ChannelConnectionStatusSchema = z.enum(['active', 'expired', 'revoked', 'error']);
export type ChannelConnectionStatus = z.infer<typeof ChannelConnectionStatusSchema>;

/**
 * Typed representation of `syndication.channel_connections`.
 * OAuth secrets and app passwords are stored in pgsodium vault columns
 * managed exclusively in `sunshade-db-platform` and never exposed here.
 */
export const ChannelConnectionSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  platform: SocialPlatformSchema,
  account_handle: z.string().min(1),
  account_urn: z.string().min(1).nullable().optional(),
  status: ChannelConnectionStatusSchema,
  token_expires_at: z.string().datetime().nullable().optional(),
  metadata: z.record(z.unknown()).default({}),
  created_at: z.string().datetime().optional(),
  updated_at: z.string().datetime().optional(),
});
export type ChannelConnection = z.infer<typeof ChannelConnectionSchema>;

/**
 * Lifecycle states for `syndication.publication_posts`.
 */
export const PublicationPostStatusSchema = z.enum([
  'draft',
  'queued',
  'publishing',
  'published',
  'partial_failure',
  'failed',
]);
export type PublicationPostStatus = z.infer<typeof PublicationPostStatusSchema>;

/**
 * Origin sources that can create a publication post.
 */
export const PublicationSourceTypeSchema = z.enum([
  'tracker',
  'substack_rss',
  'manual',
  'hub',
]);
export type PublicationSourceType = z.infer<typeof PublicationSourceTypeSchema>;

/**
 * Typed representation of `syndication.publication_posts`.
 */
export const PublicationPostSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  source_type: PublicationSourceTypeSchema,
  source_ref_id: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  canonical_url: z.string().url(),
  short_url: z.string().url().nullable().optional(),
  media_urls: z.array(z.string().url()).default([]),
  status: PublicationPostStatusSchema,
  scheduled_at: z.string().datetime().nullable().optional(),
  published_at: z.string().datetime().nullable().optional(),
  created_at: z.string().datetime().optional(),
  updated_at: z.string().datetime().optional(),
});
export type PublicationPost = z.infer<typeof PublicationPostSchema>;

/**
 * Typed representation of `syndication.feed_history` for RSS deduplication.
 */
export const FeedHistorySchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  feed_url: z.string().url(),
  item_guid: z.string().min(1),
  item_url: z.string().url(),
  title: z.string().min(1),
  published_at: z.string().datetime(),
  publication_post_id: z.string().uuid().nullable().optional(),
  processed_at: z.string().datetime().optional(),
});
export type FeedHistory = z.infer<typeof FeedHistorySchema>;

/**
 * Per-channel dispatch status values.
 */
export const ChannelDispatchStatusSchema = z.enum([
  'pending',
  'retrying',
  'published',
  'failed',
  'skipped',
]);
export type ChannelDispatchStatus = z.infer<typeof ChannelDispatchStatusSchema>;

/**
 * Payload carried inside an isolated per-channel queue message.
 */
export const DispatchPayloadSchema = z.object({
  text: z.string().min(1),
  linkUrl: z.string().url().optional(),
  mediaUrls: z.array(z.string().url()).default([]),
  threadChunks: z.array(z.string().min(1)).optional(),
});
export type DispatchPayload = z.infer<typeof DispatchPayloadSchema>;

/**
 * Per-channel queue job enqueued to `SYNDICATION_QUEUE`.
 * Each job targets exactly one `channel_connection_id` so retries stay isolated.
 */
export const ChannelDispatchJobSchema = z.object({
  dispatch_id: z.string().uuid(),
  post_id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  channel_connection_id: z.string().uuid(),
  platform: SocialPlatformSchema,
  idempotency_key: z.string().min(1),
  attempt: z.number().int().min(1).default(1),
  payload: DispatchPayloadSchema,
});
export type ChannelDispatchJob = z.infer<typeof ChannelDispatchJobSchema>;

/**
 * Inbound webhook payload from SunShade Tracker when an item status changes.
 */
export const TrackerWebhookPayloadSchema = z.object({
  event: z.enum(['item.status_changed', 'item.syndicated']),
  timestamp: z.string().datetime(),
  tenant_id: z.string().uuid(),
  data: z.object({
    item_id: z.string().uuid(),
    external_ref_id: z.string().min(1),
    project_key: z.string().min(1),
    title: z.string().min(1),
    summary: z.string().optional(),
    old_status: z.string().min(1),
    new_status: z.string().min(1),
    canonical_url: z.string().url(),
    tags: z.array(z.string()).default([]),
    media_urls: z.array(z.string().url()).default([]),
    target_platforms: z.array(SocialPlatformSchema).optional(),
  }),
});
export type TrackerWebhookPayload = z.infer<typeof TrackerWebhookPayloadSchema>;
