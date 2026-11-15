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

  describe('scheduled_for cadence support', () => {
    it('defers execution when scheduled_for is in the future by invoking message.retry with delaySeconds', async () => {
      const blueskyAdapter = createSuccessMockAdapter('bluesky');
      const fixedNow = 1700000000000; // Epoch timestamp
      const futureTime = new Date(fixedNow + 120 * 1000).toISOString(); // +120 seconds

      const scheduledMsg = createMockQueueMessage({
        dispatch_id: 'd-sched',
        post_id: 'post-sched',
        tenant_id: 't-1',
        channel_connection_id: 'c-sched-bsky',
        platform: 'bluesky',
        idempotency_key: 'post-sched:c-sched-bsky',
        attempt: 1,
        scheduled_for: futureTime,
        payload: { text: 'Scheduled future message' },
      });

      const outcomes = await processDispatchBatch([scheduledMsg], {
        adapters: {
          bluesky: blueskyAdapter,
          linkedin: createSuccessMockAdapter('linkedin'),
          x: createSuccessMockAdapter('x'),
          meta: createSuccessMockAdapter('meta'),
        },
        now: () => fixedNow,
      });

      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]?.action).toBe('retried');
      expect(scheduledMsg.retried).toBe(true);
      expect(scheduledMsg.acked).toBe(false);
      expect(scheduledMsg.retryOptions?.delaySeconds).toBe(120);
      expect(blueskyAdapter.calls).toHaveLength(0); // Adapter must NOT be called before cadence arrives
    });

    it('proceeds immediately to dispatch when scheduled_for is in the past', async () => {
      const blueskyAdapter = createSuccessMockAdapter('bluesky');
      const fixedNow = 1700000000000;
      const pastTime = new Date(fixedNow - 30 * 1000).toISOString(); // 30 seconds ago

      const pastMsg = createMockQueueMessage({
        dispatch_id: 'd-past',
        post_id: 'post-past',
        tenant_id: 't-1',
        channel_connection_id: 'c-past-bsky',
        platform: 'bluesky',
        idempotency_key: 'post-past:c-past-bsky',
        attempt: 1,
        scheduled_for: pastTime,
        payload: { text: 'Past scheduled message' },
      });

      const outcomes = await processDispatchBatch([pastMsg], {
        adapters: {
          bluesky: blueskyAdapter,
          linkedin: createSuccessMockAdapter('linkedin'),
          x: createSuccessMockAdapter('x'),
          meta: createSuccessMockAdapter('meta'),
        },
        now: () => fixedNow,
      });

      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]?.action).toBe('acked');
      expect(pastMsg.acked).toBe(true);
      expect(pastMsg.retried).toBe(false);
      expect(blueskyAdapter.calls).toHaveLength(1);
    });
  });

  function createMockSupabase(
    initialDispatches: Record<string, any> = {},
    initialPosts: Record<string, any> = {},
  ) {
    const dispatches: Record<string, any> = { ...initialDispatches };
    const posts: Record<string, any> = { ...initialPosts };

    const db = {
      from: (table: string) => {
        if (table === 'channel_dispatches') {
          return {
            select: () => {
              const filters: Record<string, string> = {};
              const builder = {
                eq: (col: string, val: string) => {
                  filters[col] = val;
                  return builder;
                },
                then: (resolve: (val: any) => void) => {
                  let rows = Object.values(dispatches);
                  if (filters.post_id) rows = rows.filter((d) => d.post_id === filters.post_id);
                  if (filters.tenant_id) rows = rows.filter((d) => d.tenant_id === filters.tenant_id);
                  if (filters.id) rows = rows.filter((d) => d.id === filters.id);
                  return resolve({ data: rows, error: null });
                },
                maybeSingle: async () => {
                  let rows = Object.values(dispatches);
                  if (filters.id) rows = rows.filter((d) => d.id === filters.id);
                  if (filters.idempotency_key) rows = rows.filter((d) => d.idempotency_key === filters.idempotency_key);
                  if (filters.tenant_id) rows = rows.filter((d) => d.tenant_id === filters.tenant_id);
                  return { data: rows[0] ?? null, error: null };
                },
              };
              return builder;
            },
            update: (updates: any) => {
              const filters: Record<string, string> = {};
              const builder = {
                eq: (col: string, val: string) => {
                  filters[col] = val;
                  return builder;
                },
                then: (resolve: (val: any) => void) => {
                  for (const [id, row] of Object.entries(dispatches)) {
                    if (filters.id && row.id !== filters.id) continue;
                    if (filters.idempotency_key && row.idempotency_key !== filters.idempotency_key) continue;
                    if (filters.tenant_id && row.tenant_id !== filters.tenant_id) continue;
                    dispatches[id] = { ...row, ...updates };
                  }
                  return resolve({ data: null, error: null });
                },
              };
              return builder;
            },
          };
        }
        if (table === 'publication_posts') {
          return {
            update: (updates: any) => {
              const filters: Record<string, string> = {};
              const builder = {
                eq: (col: string, val: string) => {
                  filters[col] = val;
                  return builder;
                },
                then: (resolve: (val: any) => void) => {
                  for (const [id, row] of Object.entries(posts)) {
                    if (filters.id && row.id !== filters.id) continue;
                    if (filters.tenant_id && row.tenant_id !== filters.tenant_id) continue;
                    posts[id] = { ...row, ...updates };
                  }
                  return resolve({ data: null, error: null });
                },
              };
              return builder;
            },
          };
        }
        throw new Error(`Unexpected table ${table}`);
      },
    };

    return { dispatches, posts, db: db as any };
  }

  describe('atomic per-channel states & duplicate prevention', () => {
    it('skips duplicate cross-post and acks message if channel_dispatches already has status=published', async () => {
      const blueskyAdapter = createSuccessMockAdapter('bluesky');

      const mockDb = {
        from: (table: string) => {
          if (table === 'channel_dispatches') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    maybeSingle: async () => ({
                      data: {
                        id: 'd-dup',
                        status: 'published',
                        platform_post_id: 'already-posted-bsky-123',
                        platform_url: 'https://bsky.app/profile/post/123',
                        attempt: 1,
                      },
                      error: null,
                    }),
                  }),
                }),
              }),
            };
          }
          throw new Error(`Unexpected table ${table}`);
        },
      } as any;

      const dupMsg = createMockQueueMessage({
        dispatch_id: 'd-dup',
        post_id: 'post-dup',
        tenant_id: 't-1',
        channel_connection_id: 'c-bsky',
        platform: 'bluesky',
        idempotency_key: 'post-dup:c-bsky',
        attempt: 2,
        payload: { text: 'Redelivered duplicate queue message' },
      });

      const outcomes = await processDispatchBatch([dupMsg], {
        adapters: {
          bluesky: blueskyAdapter,
          linkedin: createSuccessMockAdapter('linkedin'),
          x: createSuccessMockAdapter('x'),
          meta: createSuccessMockAdapter('meta'),
        },
        db: mockDb,
      });

      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]?.action).toBe('acked');
      expect(outcomes[0]?.result.platformPostId).toBe('already-posted-bsky-123');
      expect(dupMsg.acked).toBe(true);
      expect(dupMsg.retried).toBe(false);
      // Adapter must NOT be called again to prevent duplicate post
      expect(blueskyAdapter.calls).toHaveLength(0);
    });

    it('skips dispatch and acks if channel_dispatches status is skipped', async () => {
      const blueskyAdapter = createSuccessMockAdapter('bluesky');

      const mockDb = {
        from: (table: string) => {
          if (table === 'channel_dispatches') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    maybeSingle: async () => ({
                      data: { id: 'd-skip', status: 'skipped' },
                      error: null,
                    }),
                  }),
                }),
              }),
            };
          }
          throw new Error(`Unexpected table ${table}`);
        },
      } as any;

      const skipMsg = createMockQueueMessage({
        dispatch_id: 'd-skip',
        post_id: 'post-skip',
        tenant_id: 't-1',
        channel_connection_id: 'c-bsky',
        platform: 'bluesky',
        idempotency_key: 'post-skip:c-bsky',
        attempt: 1,
        payload: { text: 'Skipped channel message' },
      });

      const outcomes = await processDispatchBatch([skipMsg], {
        adapters: {
          bluesky: blueskyAdapter,
          linkedin: createSuccessMockAdapter('linkedin'),
          x: createSuccessMockAdapter('x'),
          meta: createSuccessMockAdapter('meta'),
        },
        db: mockDb,
      });

      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]?.action).toBe('acked');
      expect(skipMsg.acked).toBe(true);
      expect(blueskyAdapter.calls).toHaveLength(0);
    });

    it('atomically updates channel_dispatches to published and syncs publication_posts to published when all channels succeed', async () => {
      const blueskyAdapter = createSuccessMockAdapter('bluesky');
      const xAdapter = createSuccessMockAdapter('x');

      const mock = createMockSupabase(
        {
          'd-1': { id: 'd-1', post_id: 'post-full', tenant_id: 't-1', idempotency_key: 'post-full:c-bsky', status: 'pending', attempt: 1 },
          'd-2': { id: 'd-2', post_id: 'post-full', tenant_id: 't-1', idempotency_key: 'post-full:c-x', status: 'pending', attempt: 1 },
        },
        {
          'post-full': { id: 'post-full', tenant_id: 't-1', status: 'queued' },
        },
      );

      const bskyMsg = createMockQueueMessage({
        dispatch_id: 'd-1',
        post_id: 'post-full',
        tenant_id: 't-1',
        channel_connection_id: 'c-bsky',
        platform: 'bluesky',
        idempotency_key: 'post-full:c-bsky',
        attempt: 1,
        payload: { text: 'Atomic broadcast test' },
      });

      const xMsg = createMockQueueMessage({
        dispatch_id: 'd-2',
        post_id: 'post-full',
        tenant_id: 't-1',
        channel_connection_id: 'c-x',
        platform: 'x',
        idempotency_key: 'post-full:c-x',
        attempt: 1,
        payload: { text: 'Atomic broadcast test' },
      });

      const outcomes = await processDispatchBatch([bskyMsg, xMsg], {
        adapters: {
          bluesky: blueskyAdapter,
          linkedin: createSuccessMockAdapter('linkedin'),
          x: xAdapter,
          meta: createSuccessMockAdapter('meta'),
        },
        db: mock.db,
      });

      expect(outcomes).toHaveLength(2);
      expect(bskyMsg.acked).toBe(true);
      expect(xMsg.acked).toBe(true);

      // Verify channel dispatches updated to published
      expect(mock.dispatches['d-1'].status).toBe('published');
      expect(mock.dispatches['d-1'].platform_post_id).toBe('bluesky-post-1');
      expect(mock.dispatches['d-2'].status).toBe('published');
      expect(mock.dispatches['d-2'].platform_post_id).toBe('x-post-1');

      // Verify overall post status synchronized to published
      expect(mock.posts['post-full'].status).toBe('published');
      expect(mock.posts['post-full'].published_at).toBeDefined();
    });

    it('atomically sets channel_dispatches to retrying on 429 without modifying publication_posts to failed', async () => {
      const linkedinAdapter = createRateLimited429MockAdapter('linkedin');
      const mock = createMockSupabase(
        {
          'd-retry': { id: 'd-retry', post_id: 'post-retry', tenant_id: 't-1', idempotency_key: 'post-retry:c-li', status: 'pending', attempt: 1 },
        },
        {
          'post-retry': { id: 'post-retry', tenant_id: 't-1', status: 'queued' },
        },
      );

      const linkedinMsg = createMockQueueMessage({
        dispatch_id: 'd-retry',
        post_id: 'post-retry',
        tenant_id: 't-1',
        channel_connection_id: 'c-li',
        platform: 'linkedin',
        idempotency_key: 'post-retry:c-li',
        attempt: 1,
        payload: { text: 'Retryable post' },
      });

      const outcomes = await processDispatchBatch([linkedinMsg], {
        adapters: {
          bluesky: createSuccessMockAdapter('bluesky'),
          linkedin: linkedinAdapter,
          x: createSuccessMockAdapter('x'),
          meta: createSuccessMockAdapter('meta'),
        },
        db: mock.db,
      });

      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]?.action).toBe('retried');
      expect(mock.dispatches['d-retry'].status).toBe('retrying');
      expect(mock.dispatches['d-retry'].attempt).toBe(2);
      expect(mock.dispatches['d-retry'].error_message).toContain('HTTP 429');
      expect(mock.posts['post-retry'].status).toBe('queued');
    });

    it('syncs publication_posts to partial_failure when one channel fails permanently and another succeeds', async () => {
      const blueskyAdapter = createSuccessMockAdapter('bluesky');
      const unauthorizedLinkedin = createUnauthorized401MockAdapter('linkedin');

      const mock = createMockSupabase(
        {
          'd-ok': { id: 'd-ok', post_id: 'post-partial', tenant_id: 't-1', idempotency_key: 'post-partial:c-bsky', status: 'pending', attempt: 1 },
          'd-fail': { id: 'd-fail', post_id: 'post-partial', tenant_id: 't-1', idempotency_key: 'post-partial:c-li', status: 'pending', attempt: 1 },
        },
        {
          'post-partial': { id: 'post-partial', tenant_id: 't-1', status: 'queued' },
        },
      );

      const okMsg = createMockQueueMessage({
        dispatch_id: 'd-ok',
        post_id: 'post-partial',
        tenant_id: 't-1',
        channel_connection_id: 'c-bsky',
        platform: 'bluesky',
        idempotency_key: 'post-partial:c-bsky',
        attempt: 1,
        payload: { text: 'Partial broadcast test' },
      });

      const failMsg = createMockQueueMessage({
        dispatch_id: 'd-fail',
        post_id: 'post-partial',
        tenant_id: 't-1',
        channel_connection_id: 'c-li',
        platform: 'linkedin',
        idempotency_key: 'post-partial:c-li',
        attempt: 1,
        payload: { text: 'Partial broadcast test' },
      });

      await processDispatchBatch([okMsg, failMsg], {
        adapters: {
          bluesky: blueskyAdapter,
          linkedin: unauthorizedLinkedin,
          x: createSuccessMockAdapter('x'),
          meta: createSuccessMockAdapter('meta'),
        },
        db: mock.db,
      });

      expect(mock.dispatches['d-ok'].status).toBe('published');
      expect(mock.dispatches['d-fail'].status).toBe('failed');
      expect(mock.posts['post-partial'].status).toBe('partial_failure');
    });

    it('syncs publication_posts to failed when all channels fail permanently', async () => {
      const unauthorizedLinkedin = createUnauthorized401MockAdapter('linkedin');
      const mock = createMockSupabase(
        {
          'd-f1': { id: 'd-f1', post_id: 'post-failed', tenant_id: 't-1', idempotency_key: 'post-failed:c-li', status: 'pending', attempt: 1 },
        },
        {
          'post-failed': { id: 'post-failed', tenant_id: 't-1', status: 'queued' },
        },
      );

      const failMsg = createMockQueueMessage({
        dispatch_id: 'd-f1',
        post_id: 'post-failed',
        tenant_id: 't-1',
        channel_connection_id: 'c-li',
        platform: 'linkedin',
        idempotency_key: 'post-failed:c-li',
        attempt: 1,
        payload: { text: 'All fail test' },
      });

      await processDispatchBatch([failMsg], {
        adapters: {
          bluesky: createSuccessMockAdapter('bluesky'),
          linkedin: unauthorizedLinkedin,
          x: createSuccessMockAdapter('x'),
          meta: createSuccessMockAdapter('meta'),
        },
        db: mock.db,
      });

      expect(mock.dispatches['d-f1'].status).toBe('failed');
      expect(mock.posts['post-failed'].status).toBe('failed');
    });
  });
});
