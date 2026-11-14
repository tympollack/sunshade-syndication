import { describe, expect, it, vi } from 'vitest';
import type { ChannelConnection } from '@digitalcanopy/syndication-core';
import type { WorkerEnv } from '../../apps/syndication-worker/src/types.js';
import {
  handleRssCron,
  parseRssFeedXml,
} from '../../apps/syndication-worker/src/workers/rssPollerWorker.js';
import type { LinksClient } from '../../apps/syndication-worker/src/lib/linksClient.js';
import type { SyndicationDbClient } from '../../apps/syndication-worker/src/lib/supabase.js';

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>SunShade Systems Dispatch</title>
    <link>https://sunshade.substack.com</link>
    <item>
      <title><![CDATA[Edge Observability &amp; Privacy-First Links &mdash; Part 2]]></title>
      <link>https://sunshade.substack.com/p/edge-observability-part-2</link>
      <guid isPermaLink="false">substack:post:987654</guid>
      <pubDate>Thu, 12 Nov 2026 14:30:00 GMT</pubDate>
      <description>&lt;p&gt;We&rsquo;re shipping deterministic shortlink routing &amp;amp; edge telemetry across Cloudflare Workers.&lt;/p&gt;</description>
      <enclosure url="https://cdn.sunshade.icu/media/edge-observability-cover.jpg" length="124580" type="image/jpeg" />
    </item>
    <item>
      <title>Article Without Enclosure</title>
      <link>https://sunshade.substack.com/p/no-image</link>
      <guid>substack:post:111222</guid>
      <pubDate>Fri, 13 Nov 2026 10:00:00 GMT</pubDate>
      <content:encoded><![CDATA[<p>Full article body inside content encoded.</p>]]></content:encoded>
    </item>
  </channel>
</rss>`;

describe('rssPollerWorker', () => {
  describe('parseRssFeedXml', () => {
    it('parses Substack RSS XML, extracts CDATA titles, normalizes entities, and extracts enclosures', () => {
      const items = parseRssFeedXml(SAMPLE_XML);
      expect(items).toHaveLength(2);

      const first = items[0]!;
      expect(first.guid).toBe('substack:post:987654');
      expect(first.title).toBe('Edge Observability & Privacy-First Links — Part 2');
      expect(first.link).toBe('https://sunshade.substack.com/p/edge-observability-part-2');
      expect(first.description).toContain('We’re shipping deterministic shortlink routing & edge telemetry');
      expect(first.enclosureUrl).toBe('https://cdn.sunshade.icu/media/edge-observability-cover.jpg');
      expect(first.pubDate).toBe('2026-11-12T14:30:00.000Z');

      const second = items[1]!;
      expect(second.guid).toBe('substack:post:111222');
      expect(second.title).toBe('Article Without Enclosure');
      expect(second.enclosureUrl).toBeUndefined();
      expect(second.description).toBe('Full article body inside content encoded.');
    });

    it('falls back to link when guid tag is omitted', () => {
      const xml = `<rss><channel><item>
        <title>No Guid Item</title>
        <link>https://sunshade.substack.com/p/no-guid</link>
      </item></channel></rss>`;

      const items = parseRssFeedXml(xml);
      expect(items).toHaveLength(1);
      expect(items[0]!.guid).toBe('https://sunshade.substack.com/p/no-guid');
    });

    it('handles media:content tags as enclosure fallback', () => {
      const xml = `<rss><channel><item>
        <title>Media Tag Item</title>
        <link>https://sunshade.substack.com/p/media-item</link>
        <guid>guid-media</guid>
        <media:content url="https://cdn.sunshade.icu/media/test.png" medium="image" />
      </item></channel></rss>`;

      const items = parseRssFeedXml(xml);
      expect(items).toHaveLength(1);
      expect(items[0]!.enclosureUrl).toBe('https://cdn.sunshade.icu/media/test.png');
    });

    it('filters out incomplete items missing title or link', () => {
      const xml = `<rss><channel>
        <item><title>Missing Link</title></item>
        <item><link>https://example.com/no-title</link></item>
      </channel></rss>`;

      const items = parseRssFeedXml(xml);
      expect(items).toHaveLength(0);
    });
  });

  describe('handleRssCron lifecycle', () => {
    const mockTenantId = '00000000-0000-0000-0000-000000000000';

    it('skips execution gracefully if no SUBSTACK_FEED_URLS are set', async () => {
      const env: WorkerEnv = {};
      const summary = await handleRssCron(env);
      expect(summary.feedsPolled).toBe(0);
      expect(summary.itemsFound).toBe(0);
    });

    it('updates KV cursor with last poll timestamp', async () => {
      const kvPut = vi.fn().mockResolvedValue(undefined);
      const mockKv = { put: kvPut } as unknown as KVNamespace;

      const env: WorkerEnv = {
        SUBSTACK_FEED_URLS: '',
        SYNDICATION_KV: mockKv,
      };

      const fixedDate = new Date('2026-11-13T20:00:00.000Z');
      await handleRssCron(env, { now: () => fixedDate });

      expect(kvPut).toHaveBeenCalledWith('syndication:last_poll_at', '2026-11-13T20:00:00.000Z');
    });

    it('fetches feed, deduplicates via feed_history, mints channel shortlinks, and queues messages', async () => {
      const insertedPosts: any[] = [];
      const insertedFeedHistory: any[] = [];
      const enqueuedBatches: any[] = [];

      const mockDb = {
        from: (table: string) => {
          if (table === 'feed_history') {
            return {
              select: () => ({
                eq: (_col1: string, _val1: string) => ({
                  eq: (_col2: string, val2: string) => ({
                    eq: () => ({
                      maybeSingle: async () => ({
                        data: val2 === 'substack:post:987654' ? { id: 'existing-id' } : null,
                        error: null,
                      }),
                    }),
                    maybeSingle: async () => ({
                      data: val2 === 'substack:post:987654' ? { id: 'existing-id' } : null,
                      error: null,
                    }),
                  }),
                }),
              }),
              insert: (entry: any) => ({
                select: () => ({
                  single: async () => {
                    insertedFeedHistory.push(entry);
                    return { data: { id: 'feed-hist-1', ...entry }, error: null };
                  },
                }),
              }),
            };
          }

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
                    const post = { id: 'post-new-uuid', ...entry };
                    insertedPosts.push(post);
                    return { data: post, error: null };
                  },
                }),
              }),
            };
          }

          if (table === 'channel_connections') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => Promise.resolve({
                    data: [
                      {
                        id: 'conn-bsky-1',
                        tenant_id: mockTenantId,
                        platform: 'bluesky',
                        account_handle: 'sunshade.bsky.social',
                        status: 'active',
                      },
                      {
                        id: 'conn-x-1',
                        tenant_id: mockTenantId,
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

      const mockFetch = vi.fn().mockResolvedValue(
        new Response(SAMPLE_XML, { status: 200, headers: { 'Content-Type': 'application/xml' } }),
      );

      const mockLinksClient = {
        createShortLink: vi.fn().mockImplementation((params) => {
          const utm = params.utmSource ? `-${params.utmSource}` : '';
          return Promise.resolve({
            shortUrl: `https://links-stag.sunshade.icu/s/minted${utm}`,
            slug: `minted${utm}`,
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
        SUBSTACK_FEED_URLS: 'https://sunshade.substack.com/feed',
        SYNDICATION_QUEUE: mockQueue,
      };

      const summary = await handleRssCron(env, {
        db: mockDb,
        fetch: mockFetch,
        linksClient: mockLinksClient,
      });

      expect(summary.feedsPolled).toBe(1);
      expect(summary.itemsFound).toBe(2);
      expect(summary.itemsSkipped).toBe(1); // 'substack:post:987654' was simulated as already existing
      expect(summary.itemsProcessed).toBe(1); // 'substack:post:111222' was new
      expect(summary.shortlinksMinted).toBe(3); // 1 for post + 2 for channels
      expect(summary.postsQueued).toBe(2); // 2 channels queued

      // Verified publication_posts record
      expect(insertedPosts).toHaveLength(1);
      expect(insertedPosts[0]!.source_ref_id).toBe('substack:post:111222');
      expect(insertedPosts[0]!.source_type).toBe('substack_rss');
      expect(insertedPosts[0]!.short_url).toBe('https://links-stag.sunshade.icu/s/minted');

      // Verified feed_history record
      expect(insertedFeedHistory).toHaveLength(1);
      expect(insertedFeedHistory[0]!.item_guid).toBe('substack:post:111222');
      expect(insertedFeedHistory[0]!.publication_post_id).toBe('post-new-uuid');

      // Verified Queue payloads
      expect(enqueuedBatches).toHaveLength(1);
      const queuedJobs = enqueuedBatches[0];
      expect(queuedJobs).toHaveLength(2);
      expect(queuedJobs[0].body.platform).toBe('bluesky');
      expect(queuedJobs[0].body.payload.linkUrl).toBe('https://links-stag.sunshade.icu/s/minted-bluesky');
      expect(queuedJobs[1].body.platform).toBe('x');
      expect(queuedJobs[1].body.payload.linkUrl).toBe('https://links-stag.sunshade.icu/s/minted-x');
    });

    it('falls back to destination URL with UTM params if Links service is unreachable', async () => {
      const enqueuedBatches: any[] = [];
      const mockDb = {
        from: (table: string) => {
          if (table === 'feed_history') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    eq: () => ({
                      maybeSingle: async () => ({ data: null, error: null }),
                    }),
                    maybeSingle: async () => ({ data: null, error: null }),
                  }),
                }),
              }),
              insert: (entry: any) => ({
                select: () => ({
                  single: async () => ({ data: { id: 'feed-1', ...entry }, error: null }),
                }),
              }),
            };
          }
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
                  single: async () => ({ data: { id: 'post-1', ...entry }, error: null }),
                }),
              }),
            };
          }
          if (table === 'channel_connections') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => Promise.resolve({
                    data: [
                      {
                        id: 'conn-bsky-1',
                        tenant_id: mockTenantId,
                        platform: 'bluesky',
                        account_handle: 'sunshade.bsky.social',
                        status: 'active',
                      },
                    ],
                    error: null,
                  }),
                }),
              }),
            };
          }
          throw new Error(`Unexpected table ${table}`);
        },
      } as unknown as SyndicationDbClient;

      const singleItemXml = `<rss><channel><item>
        <title>Fallback Test Item</title>
        <link>https://sunshade.substack.com/p/fallback-item</link>
        <guid>guid-fallback-1</guid>
      </item></channel></rss>`;

      const mockFetch = vi.fn().mockResolvedValue(
        new Response(singleItemXml, { status: 200, headers: { 'Content-Type': 'application/xml' } }),
      );

      const failingLinksClient = {
        createShortLink: vi.fn().mockResolvedValue(null),
      } as unknown as LinksClient;

      const mockQueue = {
        sendBatch: vi.fn().mockImplementation(async (batch) => {
          enqueuedBatches.push(batch);
        }),
      } as unknown as Queue<any>;

      const env: WorkerEnv = {
        SUBSTACK_FEED_URLS: 'https://sunshade.substack.com/feed',
        SYNDICATION_QUEUE: mockQueue,
      };

      const summary = await handleRssCron(env, {
        db: mockDb,
        fetch: mockFetch,
        linksClient: failingLinksClient,
      });

      expect(summary.itemsProcessed).toBe(1);
      expect(summary.shortlinksMinted).toBe(0);
      expect(enqueuedBatches[0][0].body.payload.linkUrl).toContain(
        'https://sunshade.substack.com/p/fallback-item?utm_source=bluesky',
      );
    });
  });
});
