import { describe, expect, it, vi } from 'vitest';
import type { ChannelDispatchJob } from '@digitalcanopy/syndication-core';
import {
  processDispatchBatch,
  type QueueMessageHandle,
} from '../../apps/syndication-worker/src/workers/dispatchWorker.js';
import {
  createRateLimited429MockAdapter,
  createSuccessMockAdapter,
  createUnauthorized401MockAdapter,
} from '../fixtures/mock-adapters.js';

function createMockQueueMessage(job: ChannelDispatchJob): QueueMessageHandle<ChannelDispatchJob> & {
  acked: boolean;
  retried: boolean;
  retryOptions?: { delaySeconds?: number };
} {
  return {
    body: job,
    acked: false,
    retried: false,
    ack() {
      this.acked = true;
    },
    retry(options) {
      this.retried = true;
      this.retryOptions = options;
    },
  };
}

describe('dispatchIsolation', () => {
  it('retries ONLY LinkedIn when it encounters HTTP 429, without duplicating Bluesky or X', async () => {
    const blueskyAdapter = createSuccessMockAdapter('bluesky');
    const linkedinAdapter = createRateLimited429MockAdapter('linkedin');
    const xAdapter = createSuccessMockAdapter('x');

    const blueskyMsg = createMockQueueMessage({
      dispatch_id: 'd1',
      post_id: 'post-100',
      tenant_id: 't-1',
      channel_connection_id: 'c-bsky',
      platform: 'bluesky',
      idempotency_key: 'post-100:c-bsky',
      attempt: 1,
      payload: { text: 'Hello Bluesky!' },
    });

    const linkedinMsg = createMockQueueMessage({
      dispatch_id: 'd2',
      post_id: 'post-100',
      tenant_id: 't-1',
      channel_connection_id: 'c-li',
      platform: 'linkedin',
      idempotency_key: 'post-100:c-li',
      attempt: 1,
      payload: { text: 'Hello LinkedIn!' },
    });

    const xMsg = createMockQueueMessage({
      dispatch_id: 'd3',
      post_id: 'post-100',
      tenant_id: 't-1',
      channel_connection_id: 'c-x',
      platform: 'x',
      idempotency_key: 'post-100:c-x',
      attempt: 1,
      payload: { text: 'Hello X!' },
    });

    const outcomes = await processDispatchBatch([blueskyMsg, linkedinMsg, xMsg], {
      adapters: {
        bluesky: blueskyAdapter,
        linkedin: linkedinAdapter,
        x: xAdapter,
        meta: createSuccessMockAdapter('meta'),
      },
    });

    expect(outcomes).toHaveLength(3);

    // Bluesky: succeeded and acked once
    expect(blueskyMsg.acked).toBe(true);
    expect(blueskyMsg.retried).toBe(false);
    expect(blueskyAdapter.calls).toHaveLength(1);

    // LinkedIn: 429 rate limit hit, retry() called with delay, NOT acked
    expect(linkedinMsg.retried).toBe(true);
    expect(linkedinMsg.acked).toBe(false);
    expect(linkedinAdapter.calls).toHaveLength(1);
    expect(linkedinMsg.retryOptions?.delaySeconds).toBeGreaterThanOrEqual(15);

    // X: succeeded and acked once, completely isolated from LinkedIn's failure
    expect(xMsg.acked).toBe(true);
    expect(xMsg.retried).toBe(false);
    expect(xAdapter.calls).toHaveLength(1);
  });

  it('acks permanent 401 unauthorized failures to prevent retry loops and triggers auth callback', async () => {
    const unauthorizedAdapter = createUnauthorized401MockAdapter('linkedin');
    const onAuthFailure = vi.fn();

    const msg = createMockQueueMessage({
      dispatch_id: 'd4',
      post_id: 'post-101',
      tenant_id: 't-1',
      channel_connection_id: 'c-li-expired',
      platform: 'linkedin',
      idempotency_key: 'post-101:c-li-expired',
      attempt: 1,
      payload: { text: 'Testing auth failure' },
    });

    const outcomes = await processDispatchBatch([msg], {
      adapters: {
        bluesky: createSuccessMockAdapter('bluesky'),
        linkedin: unauthorizedAdapter,
        x: createSuccessMockAdapter('x'),
        meta: createSuccessMockAdapter('meta'),
      },
      onChannelAuthFailure: onAuthFailure,
    });

    expect(outcomes[0]?.action).toBe('failed');
    expect(msg.acked).toBe(true);
    expect(msg.retried).toBe(false);
    expect(onAuthFailure).toHaveBeenCalledTimes(1);
  });
});
