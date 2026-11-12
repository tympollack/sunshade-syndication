import type { ChannelDispatchJob, SocialPlatform } from '@digitalcanopy/syndication-core';
import type { WorkerEnv } from '../types.js';
import type { DispatchResult, SocialAdapter } from '../adapters/types.js';
import { BlueskyAdapter } from '../adapters/bluesky.js';
import { LinkedInAdapter } from '../adapters/linkedin.js';
import { XTwitterAdapter } from '../adapters/xTwitter.js';
import { MetaGraphAdapter } from '../adapters/metaGraph.js';
import { logger } from '../lib/logger.js';
import { getSyndicationDbClient } from '../lib/supabase.js';

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
  onChannelAuthFailure?: (job: ChannelDispatchJob, result: DispatchResult) => Promise<void>;
}

/**
 * Processes a batch of per-channel dispatch messages with strict fault isolation.
 * A retryable failure (e.g. HTTP 429 on LinkedIn) invokes `message.retry()` ONLY for that
 * message, while independent channels (e.g. Bluesky, X) call `message.ack()` and are never duplicated.
 */
export async function processDispatchBatch(
  messages: ReadonlyArray<QueueMessageHandle<ChannelDispatchJob>>,
  deps: ProcessDispatchDeps = {},
): Promise<DispatchOutcome[]> {
  const adapters = deps.adapters ?? createDefaultAdapters();
  const outcomes: DispatchOutcome[] = [];

  for (const message of messages) {
    const job = message.body;
    const adapter = adapters[job.platform];

    if (!adapter) {
      logger.error('No adapter registered for platform; acking to prevent retry loop', {
        dispatchId: job.dispatch_id,
        platform: job.platform,
      });
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
      const backoffSeconds = Math.min(300, 15 * 2 ** Math.max(0, job.attempt - 1));
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
  return processDispatchBatch(batch.messages, {
    onChannelAuthFailure: async (job) => {
      if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return;
      const db = getSyndicationDbClient(env);
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
