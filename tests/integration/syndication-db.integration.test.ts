import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupSyndicationTestTenant,
  initSyndicationDbHarness,
  type DbHarnessContext,
} from './helpers/db-test-harness.js';

describe('syndication.* database contract', () => {
  let ctx: DbHarnessContext;

  beforeAll(async () => {
    ctx = await initSyndicationDbHarness();
    if (!ctx.available) {
      console.warn(`[test:db SKIPPED] ${ctx.skipReason}`);
    }
  });

  afterAll(async () => {
    if (ctx?.available) {
      await cleanupSyndicationTestTenant(ctx.db, ctx.testTenantId);
    }
  });

  it('exposes syndication.channel_connections, publication_posts, and feed_history', async (testCtx) => {
    if (!ctx.available || !ctx.db) {
      testCtx.skip();
      return;
    }

    const { data: channel, error: chErr } = await ctx.db
      .from('channel_connections')
      .insert({
        tenant_id: ctx.testTenantId,
        platform: 'bluesky',
        account_handle: 'integration-test.bsky.social',
        status: 'active',
      })
      .select('id, platform, status')
      .single();

    expect(chErr).toBeNull();
    expect(channel?.platform).toBe('bluesky');

    const { data: post, error: postErr } = await ctx.db
      .from('publication_posts')
      .insert({
        tenant_id: ctx.testTenantId,
        source_type: 'manual',
        source_ref_id: `IT-${Date.now()}`,
        title: 'Integration Test Post',
        body: 'Verifying syndication schema roundtrip.',
        canonical_url: 'https://publish-stag.sunshade.icu/posts/it-1',
        status: 'draft',
      })
      .select('id, title')
      .single();

    expect(postErr).toBeNull();
    expect(post?.title).toBe('Integration Test Post');

    const guid = `guid-${Date.now()}`;
    const { data: feedRow, error: feedErr } = await ctx.db
      .from('feed_history')
      .insert({
        tenant_id: ctx.testTenantId,
        feed_url: 'https://sunshade.substack.com/feed',
        item_guid: guid,
        item_url: 'https://sunshade.substack.com/p/test',
        title: 'Integration Feed Item',
        published_at: new Date().toISOString(),
        publication_post_id: post?.id,
      })
      .select('id, item_guid')
      .single();

    expect(feedErr).toBeNull();
    expect(feedRow?.item_guid).toBe(guid);
  });

  it('blocks anonymous read access on syndication tables via RLS', async (testCtx) => {
    if (!ctx.available || !ctx.anonDb) {
      testCtx.skip();
      return;
    }

    const { data, error } = await ctx.anonDb
      .from('channel_connections')
      .select('id')
      .eq('tenant_id', ctx.testTenantId);

    // Either RLS denies with empty rows or permission error
    if (!error) {
      expect(data ?? []).toHaveLength(0);
    }
  });
});
