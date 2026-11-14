import {
  buildPlatformExcerpt,
  TrackerWebhookPayloadSchema,
  verifyHmacSha256Signature,
  type ChannelDispatchJob,
} from '@digitalcanopy/syndication-core';
import type { WorkerEnv } from '../types.js';
import { logger } from '../lib/logger.js';
import { LinksClient } from '../lib/linksClient.js';
import {
  createPublicationPost,
  getActiveChannelConnections,
  getPublicationPostBySource,
  getSyndicationDbClient,
  recordChannelDispatches,
  type SyndicationDbClient,
} from '../lib/supabase.js';

export interface TrackerWebhookOptions {
  db?: SyndicationDbClient;
  linksClient?: LinksClient;
}

/**
 * Handles `POST /api/v1/webhooks/tracker` verified via `X-SunShade-Signature-256`.
 * Enqueues broadcast dispatch jobs when work items transition to `syndicated`.
 * Enforces constant-time HMAC verification, schema validation, GUID deduplication,
 * and channel shortlink minting.
 */
export async function handleTrackerWebhook(
  request: Request,
  env: WorkerEnv,
  options: TrackerWebhookOptions = {},
): Promise<Response> {
  const secret = env.TRACKER_WEBHOOK_SECRET;
  if (!secret) {
    logger.error('TRACKER_WEBHOOK_SECRET is not configured');
    return new Response(JSON.stringify({ error: 'Webhook secret not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const rawBody = await request.text();
  const signatureHeader = request.headers.get('X-SunShade-Signature-256');
  const isValidSignature = await verifyHmacSha256Signature(rawBody, signatureHeader, secret);

  if (!isValidSignature) {
    logger.warn('Rejected tracker webhook with invalid HMAC signature');
    return new Response(JSON.stringify({ error: 'Invalid webhook signature' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    return new Response(JSON.stringify({ error: 'Malformed JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const parsed = TrackerWebhookPayloadSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return new Response(
      JSON.stringify({ error: 'Invalid tracker webhook payload', issues: parsed.error.issues }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const payload = parsed.data;
  const isSyndicated =
    payload.data.new_status === 'syndicated' || payload.event === 'item.syndicated';

  if (!isSyndicated) {
    logger.info('Ignored tracker webhook: item status is not syndicated', {
      externalRefId: payload.data.external_ref_id,
      newStatus: payload.data.new_status,
      event: payload.event,
    });
    return new Response(
      JSON.stringify({ accepted: true, ignored: true, reason: 'Status is not syndicated' }),
      { status: 202, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const db = options.db ?? getSyndicationDbClient(env);
  const linksClient = options.linksClient ?? new LinksClient(env);

  // Idempotency check: if post exists, verify if channel dispatches were already successfully enqueued
  const existingPost = await getPublicationPostBySource(
    db,
    payload.tenant_id,
    'tracker',
    payload.data.external_ref_id,
  );

  if (existingPost) {
    const { data: existingDispatches } = await db
      .from('channel_dispatches')
      .select('id')
      .eq('tenant_id', payload.tenant_id)
      .eq('post_id', existingPost.id);

    if (existingDispatches && existingDispatches.length > 0) {
      logger.info('Tracker webhook item already processed and dispatched; skipping duplicate broadcast', {
        postId: existingPost.id,
        externalRefId: payload.data.external_ref_id,
        dispatchCount: existingDispatches.length,
      });
      return new Response(
        JSON.stringify({
          accepted: true,
          duplicate: true,
          postId: existingPost.id,
          message: 'Item already syndicated',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
  }

  // Reuse existing post if previous run failed before dispatching, or create new post
  let post = existingPost;
  if (!post) {
    // Mint canonical shortlink for the post
    let postShortUrl: string | undefined;
    try {
      const shortLinkResult = await linksClient.createShortLink({
        destinationUrl: payload.data.canonical_url,
        tenantId: payload.tenant_id,
        title: payload.data.title,
        utmCampaign: payload.data.project_key,
      });
      postShortUrl = shortLinkResult?.shortUrl;
    } catch (err) {
      logger.warn('Failed to mint post-level shortlink for tracker webhook; falling back', {
        externalRefId: payload.data.external_ref_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    post = await createPublicationPost(db, {
      tenant_id: payload.tenant_id,
      source_type: 'tracker',
      source_ref_id: payload.data.external_ref_id,
      title: payload.data.title,
      body: payload.data.summary ?? payload.data.title,
      canonical_url: payload.data.canonical_url,
      short_url: postShortUrl,
      media_urls: payload.data.media_urls,
      status: 'queued',
    });
  }

  const channels = await getActiveChannelConnections(db, payload.tenant_id);
  const targetChannels = payload.data.target_platforms
    ? channels.filter((ch) => payload.data.target_platforms!.includes(ch.platform))
    : channels;

  if (env.SYNDICATION_QUEUE && targetChannels.length > 0) {
    const queueMessages: Array<{ body: ChannelDispatchJob }> = [];

    for (const channel of targetChannels) {
      let channelShortUrl = post.short_url ?? undefined;
      try {
        const channelShortLink = await linksClient.createShortLink({
          destinationUrl: payload.data.canonical_url,
          tenantId: payload.tenant_id,
          title: payload.data.title,
          utmSource: channel.platform,
          utmMedium: 'social',
          utmCampaign: payload.data.project_key,
        });
        if (channelShortLink?.shortUrl) {
          channelShortUrl = channelShortLink.shortUrl;
        }
      } catch (err) {
        logger.warn('Failed to mint channel-level shortlink for tracker webhook; falling back', {
          platform: channel.platform,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const excerpt = buildPlatformExcerpt({
        title: post.title,
        body: post.body,
        url: post.canonical_url,
        shortUrl: channelShortUrl,
        platform: channel.platform,
        campaign: payload.data.project_key,
        tags: payload.data.tags,
      });

      queueMessages.push({
        body: {
          dispatch_id: crypto.randomUUID(),
          post_id: post.id,
          tenant_id: payload.tenant_id,
          channel_connection_id: channel.id,
          platform: channel.platform,
          idempotency_key: `${post.id}:${channel.id}`,
          attempt: 1,
          payload: {
            text: excerpt.text,
            linkUrl: excerpt.linkUrl,
            mediaUrls: post.media_urls,
            threadChunks: excerpt.threadChunks,
          },
        },
      });
    }

    await env.SYNDICATION_QUEUE.sendBatch(queueMessages);

    // Record pending dispatches in channel_dispatches to protect against duplicate retry submission
    await recordChannelDispatches(
      db,
      queueMessages.map((msg) => ({
        id: msg.body.dispatch_id,
        tenant_id: payload.tenant_id,
        post_id: post!.id,
        channel_connection_id: msg.body.channel_connection_id,
        platform: msg.body.platform,
        status: 'pending',
        idempotency_key: msg.body.idempotency_key,
        attempt: 1,
      })),
    );
  }

  logger.info('Queued tracker item for syndication', {
    postId: post.id,
    externalRefId: payload.data.external_ref_id,
    channelCount: targetChannels.length,
  });

  return new Response(
    JSON.stringify({
      accepted: true,
      postId: post.id,
      queuedChannels: targetChannels.length,
    }),
    { status: 202, headers: { 'Content-Type': 'application/json' } },
  );
}
