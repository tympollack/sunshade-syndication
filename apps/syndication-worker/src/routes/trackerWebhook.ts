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
  getSyndicationDbClient,
} from '../lib/supabase.js';

/**
 * Handles `POST /api/v1/webhooks/tracker` verified via `X-SunShade-Signature-256`.
 */
export async function handleTrackerWebhook(
  request: Request,
  env: WorkerEnv,
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
  if (payload.data.new_status !== 'syndicated') {
    return new Response(
      JSON.stringify({ accepted: true, ignored: true, reason: 'Status is not syndicated' }),
      { status: 202, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const db = getSyndicationDbClient(env);
  const linksClient = new LinksClient(env);

  const shortLinkResult = await linksClient.createShortLink({
    destinationUrl: payload.data.canonical_url,
    tenantId: payload.tenant_id,
    title: payload.data.title,
    utmCampaign: payload.data.project_key,
  });

  const post = await createPublicationPost(db, {
    tenant_id: payload.tenant_id,
    source_type: 'tracker',
    source_ref_id: payload.data.external_ref_id,
    title: payload.data.title,
    body: payload.data.summary ?? payload.data.title,
    canonical_url: payload.data.canonical_url,
    short_url: shortLinkResult?.shortUrl,
    media_urls: payload.data.media_urls,
    status: 'queued',
  });

  const channels = await getActiveChannelConnections(db, payload.tenant_id);
  const targetChannels = payload.data.target_platforms
    ? channels.filter((ch) => payload.data.target_platforms!.includes(ch.platform))
    : channels;

  if (env.SYNDICATION_QUEUE && targetChannels.length > 0) {
    const queueMessages: Array<{ body: ChannelDispatchJob }> = targetChannels.map((channel) => {
      const excerpt = buildPlatformExcerpt({
        title: post.title,
        body: post.body,
        url: post.canonical_url,
        shortUrl: post.short_url ?? undefined,
        platform: channel.platform,
        tags: payload.data.tags,
      });

      return {
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
      };
    });

    await env.SYNDICATION_QUEUE.sendBatch(queueMessages);
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
