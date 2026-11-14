import { describe, expect, it, vi } from 'vitest';
import { signHmacSha256Header, type ChannelConnection } from '@digitalcanopy/syndication-core';
import type { WorkerEnv } from '../../apps/syndication-worker/src/types.js';
import { handleTrackerWebhook } from '../../apps/syndication-worker/src/routes/trackerWebhook.js';
import type { LinksClient } from '../../apps/syndication-worker/src/lib/linksClient.js';
import type { SyndicationDbClient } from '../../apps/syndication-worker/src/lib/supabase.js';

const TEST_SECRET = 'test-hmac-secret-12345';
const VALID_PAYLOAD = {
  event: 'item.status_changed',
  timestamp: '2026-11-12T15:00:00.000Z',
  tenant_id: '00000000-0000-0000-0000-000000000000',
  data: {
    item_id: '33333333-3333-4333-8333-333333333301',
    external_ref_id: 'SYN-104',
    project_key: 'SYN',
    title: 'Introducing SunShade Syndication Edge Worker',
    summary: 'Isolated multi-channel publishing across Bluesky, LinkedIn, X, and Meta.',
    old_status: 'in_review',
    new_status: 'syndicated',
    canonical_url: 'https://publish-stag.sunshade.icu/posts/syn-104',
    tags: ['SunShade', 'CloudflareWorkers', 'Edge'],
    media_urls: ['https://cdn.sunshade.icu/media/syn-104.png'],
    target_platforms: ['bluesky', 'x'],
  },
};

async function createSignedRequest(
  body: unknown,
  secret: string = TEST_SECRET,
  customHeader?: string,
): Promise<Request> {
  const bodyText = typeof body === 'string' ? body : JSON.stringify(body);
  const signature = customHeader ?? (await signHmacSha256Header(bodyText, secret));

  return new Request('https://publish-stag.sunshade.icu/api/v1/webhooks/tracker', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-SunShade-Signature-256': signature,
    },
    body: bodyText,
  });
}

describe('trackerWebhook', () => {
  it('returns 500 when TRACKER_WEBHOOK_SECRET is not configured', async () => {
    const request = new Request('https://publish-stag.sunshade.icu/api/v1/webhooks/tracker', {
      method: 'POST',
      body: JSON.stringify(VALID_PAYLOAD),
    });

    const env: WorkerEnv = {};
    const res = await handleTrackerWebhook(request, env);

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Webhook secret not configured');
  });

  it('rejects requests with missing or invalid HMAC signature (401)', async () => {
    const env: WorkerEnv = { TRACKER_WEBHOOK_SECRET: TEST_SECRET };

    // Request without signature header
    const noSigReq = new Request('https://publish-stag.sunshade.icu/api/v1/webhooks/tracker', {
      method: 'POST',
      body: JSON.stringify(VALID_PAYLOAD),
    });
    const resNoSig = await handleTrackerWebhook(noSigReq, env);
    expect(resNoSig.status).toBe(401);

    // Request with forged signature header
    const badSigReq = await createSignedRequest(
      VALID_PAYLOAD,
      TEST_SECRET,
      'sha256=0000000000000000000000000000000000000000000000000000000000000000',
    );
    const resBadSig = await handleTrackerWebhook(badSigReq, env);
    expect(resBadSig.status).toBe(401);
  });

  it('returns 400 on malformed JSON payload', async () => {
    const env: WorkerEnv = { TRACKER_WEBHOOK_SECRET: TEST_SECRET };
    const req = await createSignedRequest('{ invalid-json ', TEST_SECRET);
    const res = await handleTrackerWebhook(req, env);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Malformed JSON body');
  });

  it('returns 400 on invalid payload schema', async () => {
    const env: WorkerEnv = { TRACKER_WEBHOOK_SECRET: TEST_SECRET };
    const invalidPayload = { ...VALID_PAYLOAD, tenant_id: 'not-a-uuid' };
    const req = await createSignedRequest(invalidPayload, TEST_SECRET);
    const res = await handleTrackerWebhook(req, env);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Invalid tracker webhook payload');
  });

  it('ignores items transitioning to a status other than syndicated (202 accepted, ignored)', async () => {
    const env: WorkerEnv = { TRACKER_WEBHOOK_SECRET: TEST_SECRET };
    const nonSyndicatedPayload = {
      ...VALID_PAYLOAD,
      data: {
        ...VALID_PAYLOAD.data,
        new_status: 'in_progress',
      },
    };

    const req = await createSignedRequest(nonSyndicatedPayload, TEST_SECRET);
    const res = await handleTrackerWebhook(req, env);

    expect(res.status).toBe(202);
    const body = (await res.json()) as { accepted: boolean; ignored: boolean; reason: string };
    expect(body.accepted).toBe(true);
    expect(body.ignored).toBe(true);
    expect(body.reason).toContain('Status is not syndicated');
  });

  it('successfully creates publication post, mints links, and queues targeted channels', async () => {
    const insertedPosts: any[] = [];
    const enqueuedBatches: any[] = [];

    const mockDb = {
      from: (table: string) => {
        if (table === 'publication_posts') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => ({
                    maybeSingle: async () => ({ data: null, error: null }),
                  }),
                }),
              }),
            }),
            insert: (entry: any) => ({
              select: () => ({
                single: async () => {
                  const record = { id: 'post-syn-104-uuid', ...entry };
                  insertedPosts.push(record);
                  return { data: record, error: null };
                },
              }),
            }),
          };
        }

        if (table === 'channel_connections') {
          return {
            select: () => ({
              eq: () => ({
                eq: () =>
                  Promise.resolve({
                    data: [
                      {
                        id: 'conn-bsky',
                        tenant_id: VALID_PAYLOAD.tenant_id,
                        platform: 'bluesky',
                        account_handle: 'sunshade.bsky.social',
                        status: 'active',
                      },
                      {
                        id: 'conn-li',
                        tenant_id: VALID_PAYLOAD.tenant_id,
                        platform: 'linkedin',
                        account_handle: 'sunshade-systems',
                        status: 'active',
                      },
                      {
                        id: 'conn-x',
                        tenant_id: VALID_PAYLOAD.tenant_id,
                        platform: 'x',
                        account_handle: '@SunShadeSystems',
                        status: 'active',
                      },
                    ] as ChannelConnection[],
                    error: null,
                  }),
              }),
            }),
          };
        }

          throw new Error(`Unexpected table ${table}`);
        },
      } as unknown as SyndicationDbClient;

      const mockLinksClient = {
        createShortLink: vi.fn().mockImplementation((params) => {
          const suffix = params.utmSource ? `-${params.utmSource}` : '';
          return Promise.resolve({
            shortUrl: `https://links-stag.sunshade.icu/s/syn104${suffix}`,
            slug: `syn104${suffix}`,
            destinationUrl: params.destinationUrl,
          });
        }),
      } as unknown as LinksClient;

      const mockQueue = {
        sendBatch: vi.fn().mockImplementation(async (batch) => {
          enqueuedBatches.push(batch);
        }),
      } as unknown as Queue<any>;

      const env: WorkerEnv = {
        TRACKER_WEBHOOK_SECRET: TEST_SECRET,
        SYNDICATION_QUEUE: mockQueue,
      };

      const req = await createSignedRequest(VALID_PAYLOAD, TEST_SECRET);
      const res = await handleTrackerWebhook(req, env, {
        db: mockDb,
        linksClient: mockLinksClient,
      });

      expect(res.status).toBe(202);
      const resBody = (await res.json()) as { accepted: boolean; postId: string; queuedChannels: number };
      expect(resBody.accepted).toBe(true);
      expect(resBody.postId).toBe('post-syn-104-uuid');
      expect(resBody.queuedChannels).toBe(2); // Only bluesky and x (target_platforms filter)

      // Post verification
      expect(insertedPosts).toHaveLength(1);
      expect(insertedPosts[0]!.source_ref_id).toBe('SYN-104');
      expect(insertedPosts[0]!.source_type).toBe('tracker');
      expect(insertedPosts[0]!.short_url).toBe('https://links-stag.sunshade.icu/s/syn104');

      // Queue verification
      expect(enqueuedBatches).toHaveLength(1);
      const jobs = enqueuedBatches[0];
      expect(jobs).toHaveLength(2);
      expect(jobs[0].body.platform).toBe('bluesky');
      expect(jobs[0].body.payload.linkUrl).toBe('https://links-stag.sunshade.icu/s/syn104-bluesky');
      expect(jobs[1].body.platform).toBe('x');
      expect(jobs[1].body.payload.linkUrl).toBe('https://links-stag.sunshade.icu/s/syn104-x');
  });

  it('deduplicates duplicate webhook deliveries idempotently without re-enqueuing', async () => {
    const mockQueue = {
      sendBatch: vi.fn(),
    } as unknown as Queue<any>;

    const mockDb = {
      from: (table: string) => {
        if (table === 'publication_posts') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => ({
                    maybeSingle: async () => ({
                      data: {
                        id: 'existing-post-id',
                        tenant_id: VALID_PAYLOAD.tenant_id,
                        source_type: 'tracker',
                        source_ref_id: 'SYN-104',
                        title: VALID_PAYLOAD.data.title,
                        body: VALID_PAYLOAD.data.summary,
                        canonical_url: VALID_PAYLOAD.data.canonical_url,
                        status: 'queued',
                      },
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
          };
        }
        throw new Error(`Unexpected table ${table}`);
      },
    } as unknown as SyndicationDbClient;

    const env: WorkerEnv = {
      TRACKER_WEBHOOK_SECRET: TEST_SECRET,
      SYNDICATION_QUEUE: mockQueue,
    };

    const req = await createSignedRequest(VALID_PAYLOAD, TEST_SECRET);
    const res = await handleTrackerWebhook(req, env, { db: mockDb });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { accepted: boolean; duplicate: boolean; postId: string };
    expect(body.accepted).toBe(true);
    expect(body.duplicate).toBe(true);
    expect(body.postId).toBe('existing-post-id');
    expect(mockQueue.sendBatch).not.toHaveBeenCalled();
  });
});
