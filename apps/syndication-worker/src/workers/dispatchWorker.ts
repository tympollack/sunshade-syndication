import type { ChannelDispatchJob, SocialPlatform } from '@digitalcanopy/syndication-core';
import type { WorkerEnv } from '../types.js';
import type { DispatchResult, SocialAdapter } from '../adapters/types.js';
import { BlueskyAdapter } from '../adapters/bluesky.js';
import { LinkedInAdapter } from '../adapters/linkedin.js';
import { XTwitterAdapter } from '../adapters/xTwitter.js';
import { MetaGraphAdapter } from '../adapters/metaGraph.js';
import { logger } from '../lib/logger.js';
import {
  getChannelDispatch,
  getSyndicationDbClient,
  syncPublicationPostStatus,
  updateChannelDispatch,
  type SyndicationDbClient,
} from '../lib/supabase.js';

export interface QueueMessageHandle<T = ChannelDispatchJob> {
  readonly id?: string;
  readonly body: T;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface DispatchOutcome {
  dispatchId: string;
  platform: SocialPlatform;
  channelConnectionId: string;
  action: 'acked' | 'retried' | 'failed';
  result: DispatchResult;
}

export type AdapterRegistry = Record<SocialPlatform, SocialAdapter>;

export function createDefaultAdapters(): AdapterRegistry {
  return {
    bluesky: new BlueskyAdapter(),
    linkedin: new LinkedInAdapter(),
    x: new XTwitterAdapter(),
    meta: new MetaGraphAdapter(),
  };
}

export interface ProcessDispatchDeps {
  adapters?: AdapterRegistry;
  db?: SyndicationDbClient;
  now?: () => number;
  onChannelAuthFailure?: (job: ChannelDispatchJob, result: DispatchResult) => Promise<void>;
}

/**
 * Processes a batch of per-channel dispatch messages with strict fault isolation.
 * A retryable failure (e.g. HTTP 429 on LinkedIn) invokes `message.retry()` ONLY for that
 * message, while independent channels (e.g. Bluesky, X) call `message.ack()` and are never duplicated.
 * Honoring `scheduled_for` timestamps defers execution without cross-posting early,
 * and checking atomic states in `channel_dispatches` prevents duplicate cross-posting on retry.
 */
export async function processDispatchBatch(
  messages: ReadonlyArray<QueueMessageHandle<ChannelDispatchJob>>,
  deps: ProcessDispatchDeps = {},
): Promise<DispatchOutcome[]> {
  const adapters = deps.adapters ?? createDefaultAdapters();
  const outcomes: DispatchOutcome[] = [];

  for (const message of messages) {
    const job = message.body;

    // 1. Scheduled Cadence Guard: honor scheduled_for timestamps
    if (job.scheduled_for) {
      const scheduledTime = new Date(job.scheduled_for).getTime();
      const currentTime = deps.now ? deps.now() : Date.now();
      if (Number.isNaN(scheduledTime)) {
        logger.warn('Invalid scheduled_for timestamp; proceeding with immediate dispatch', {
          dispatchId: job.dispatch_id,
          scheduledFor: job.scheduled_for,
        });
      } else if (scheduledTime > currentTime) {
        const delaySeconds = Math.max(1, Math.min(900, Math.ceil((scheduledTime - currentTime) / 1000)));
        logger.info('Channel dispatch scheduled for future; delaying message in queue', {
          dispatchId: job.dispatch_id,
          postId: job.post_id,
          platform: job.platform,
          scheduledFor: job.scheduled_for,
          delaySeconds,
        });
        message.retry({ delaySeconds });
        outcomes.push({
          dispatchId: job.dispatch_id,
          platform: job.platform,
          channelConnectionId: job.channel_connection_id,
          action: 'retried',
          result: {
            success: false,
            retryable: true,
            error: `Scheduled for future execution at ${job.scheduled_for}`,
          },
        });
        continue;
      }
    }

    // 2. Atomic per-channel idempotency check in channel_dispatches
    let existing: { status: string; platform_post_id?: string | null; platform_url?: string | null; attempt?: number } | null = null;

    if (deps.db) {
      try {
        existing = await getChannelDispatch(deps.db, {
          dispatchId: job.dispatch_id,
          tenantId: job.tenant_id,
          idempotencyKey: job.idempotency_key,
        });

        if (existing?.status === 'published') {
          logger.info('Channel dispatch already published; skipping duplicate broadcast and acking', {
            dispatchId: job.dispatch_id,
            postId: job.post_id,
            platform: job.platform,
            platformPostId: existing.platform_post_id,
          });
          message.ack();
          outcomes.push({
            dispatchId: job.dispatch_id,
            platform: job.platform,
            channelConnectionId: job.channel_connection_id,
            action: 'acked',
            result: {
              success: true,
              retryable: false,
              platformPostId: existing.platform_post_id ?? undefined,
              platformUrl: existing.platform_url ?? undefined,
            },
          });
          continue;
        }

        if (existing?.status === 'skipped') {
          logger.info('Channel dispatch marked skipped; acking without broadcast', {
            dispatchId: job.dispatch_id,
            postId: job.post_id,
            platform: job.platform,
          });
          message.ack();
          outcomes.push({
            dispatchId: job.dispatch_id,
            platform: job.platform,
            channelConnectionId: job.channel_connection_id,
            action: 'acked',
            result: {
              success: false,
              retryable: false,
              error: 'Channel dispatch skipped',
            },
          });
          continue;
        }
      } catch (err) {
        logger.warn('Failed to verify existing dispatch state; proceeding with dispatch', {
          dispatchId: job.dispatch_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const currentAttempt = Math.max(job.attempt, existing?.attempt ?? 1);
    const adapter = adapters[job.platform];

    if (!adapter) {
      logger.error('No adapter registered for platform; acking to prevent retry loop', {
        dispatchId: job.dispatch_id,
        platform: job.platform,
      });

      if (deps.db) {
        try {
          await updateChannelDispatch(deps.db, {
            dispatchId: job.dispatch_id,
            tenantId: job.tenant_id,
            idempotencyKey: job.idempotency_key,
            status: 'failed',
            attempt: currentAttempt,
            errorMessage: `Unsupported platform: ${job.platform}`,
          });
          await syncPublicationPostStatus(deps.db, job.post_id, job.tenant_id);
        } catch (dbErr) {
          logger.error('Failed to update channel dispatch status in DB for missing adapter', {
            dispatchId: job.dispatch_id,
            error: dbErr instanceof Error ? dbErr.message : String(dbErr),
          });
        }
      }

      message.ack();
      outcomes.push({
        dispatchId: job.dispatch_id,
        platform: job.platform,
        channelConnectionId: job.channel_connection_id,
        action: 'failed',
        result: {
          success: false,
          retryable: false,
          error: `Unsupported platform: ${job.platform}`,
        },
      });
      continue;
    }

    const result = await adapter.dispatch({
      tenantId: job.tenant_id,
      postId: job.post_id,
      connectionId: job.channel_connection_id,
      platform: job.platform,
      text: job.payload.text,
      linkUrl: job.payload.linkUrl,
      mediaUrls: job.payload.mediaUrls,
      threadChunks: job.payload.threadChunks,
    });

    if (result.success) {
      if (deps.db) {
        try {
          await updateChannelDispatch(deps.db, {
            dispatchId: job.dispatch_id,
            tenantId: job.tenant_id,
            idempotencyKey: job.idempotency_key,
            status: 'published',
            platformPostId: result.platformPostId,
            platformUrl: result.platformUrl,
            dispatchedAt: new Date(deps.now ? deps.now() : Date.now()).toISOString(),
            attempt: currentAttempt,
          });
          await syncPublicationPostStatus(deps.db, job.post_id, job.tenant_id);
        } catch (dbErr) {
          logger.error('Failed to update channel_dispatches on success', {
            dispatchId: job.dispatch_id,
            error: dbErr instanceof Error ? dbErr.message : String(dbErr),
          });
        }
      }

      message.ack();
      logger.info('Channel dispatch succeeded', {
        dispatchId: job.dispatch_id,
        postId: job.post_id,
        platform: job.platform,
        platformPostId: result.platformPostId,
      });
      outcomes.push({
        dispatchId: job.dispatch_id,
        platform: job.platform,
        channelConnectionId: job.channel_connection_id,
        action: 'acked',
        result,
      });
      continue;
    }

    if (result.retryable) {
      const backoffSeconds = Math.min(300, 15 * 2 ** Math.max(0, currentAttempt - 1));

      if (deps.db) {
        try {
          await updateChannelDispatch(deps.db, {
            dispatchId: job.dispatch_id,
            tenantId: job.tenant_id,
            idempotencyKey: job.idempotency_key,
            status: 'retrying',
            attempt: currentAttempt + 1,
            errorMessage: result.error,
          });
        } catch (dbErr) {
          logger.error('Failed to update channel_dispatches on retryable error', {
            dispatchId: job.dispatch_id,
            error: dbErr instanceof Error ? dbErr.message : String(dbErr),
          });
        }
      }

      message.retry({ delaySeconds: backoffSeconds });
      logger.warn('Channel dispatch hit retryable error; retrying single channel only', {
        dispatchId: job.dispatch_id,
        postId: job.post_id,
        platform: job.platform,
        statusCode: result.statusCode,
        delaySeconds: backoffSeconds,
      });
      outcomes.push({
        dispatchId: job.dispatch_id,
        platform: job.platform,
        channelConnectionId: job.channel_connection_id,
        action: 'retried',
        result,
      });
      continue;
    }

    // Non-retryable failure (e.g. 401 unauthorized / 400 validation error)
    if (deps.db) {
      try {
        await updateChannelDispatch(deps.db, {
          dispatchId: job.dispatch_id,
          tenantId: job.tenant_id,
          idempotencyKey: job.idempotency_key,
          status: 'failed',
          attempt: currentAttempt,
          errorMessage: result.error,
        });
        await syncPublicationPostStatus(deps.db, job.post_id, job.tenant_id);
      } catch (dbErr) {
        logger.error('Failed to update channel_dispatches on permanent failure', {
          dispatchId: job.dispatch_id,
          error: dbErr instanceof Error ? dbErr.message : String(dbErr),
        });
      }
    }

    if (result.statusCode === 401 && deps.onChannelAuthFailure) {
      await deps.onChannelAuthFailure(job, result);
    }

    message.ack();
    logger.error('Channel dispatch failed permanently; acking to avoid infinite retries', {
      dispatchId: job.dispatch_id,
      postId: job.post_id,
      platform: job.platform,
      statusCode: result.statusCode,
      error: result.error,
    });
    outcomes.push({
      dispatchId: job.dispatch_id,
      platform: job.platform,
      channelConnectionId: job.channel_connection_id,
      action: 'failed',
      result,
    });
  }

  return outcomes;
}

/**
 * Cloudflare Queue consumer entrypoint for `SYNDICATION_QUEUE`.
 */
export async function handleQueueBatch(
  batch: MessageBatch<ChannelDispatchJob>,
  env: WorkerEnv,
): Promise<DispatchOutcome[]> {
  const db = env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY
    ? getSyndicationDbClient(env)
    : undefined;

  return processDispatchBatch(batch.messages, {
    db,
    onChannelAuthFailure: async (job) => {
      if (!db) return;
      const { error } = await db
        .from('channel_connections')
        .update({ status: 'expired' })
        .eq('id', job.channel_connection_id)
        .eq('tenant_id', job.tenant_id);

      if (error) {
        logger.error('Failed to mark channel connection expired after 401', {
          channelConnectionId: job.channel_connection_id,
          error: error.message,
        });
      }
    },
  });
}
