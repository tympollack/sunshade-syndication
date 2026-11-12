import { buildPlatformExcerpt, normalizeCopy } from '@digitalcanopy/syndication-core';
import type { WorkerEnv } from '../types.js';
import { logger } from '../lib/logger.js';
import {
  createPublicationPost,
  getActiveChannelConnections,
  getSyndicationDbClient,
  isFeedItemProcessed,
  recordFeedHistory,
} from '../lib/supabase.js';

export interface ParsedRssItem {
  guid: string;
  title: string;
  link: string;
  description: string;
  pubDate: string;
  enclosureUrl?: string;
}

function extractTag(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  const raw = match?.[1] ?? '';
  return raw.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/i, '$1').trim();
}

/**
 * Minimal deterministic RSS 2.0 XML parser for Substack feeds.
 */
export function parseRssFeedXml(xml: string): ParsedRssItem[] {
  const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/gi);
  const items: ParsedRssItem[] = [];

  for (const match of itemMatches) {
    const block = match[1] ?? '';
    const title = normalizeCopy(extractTag(block, 'title'));
    const link = extractTag(block, 'link');
    const guid = extractTag(block, 'guid') || link;
    const description = normalizeCopy(extractTag(block, 'description'));
    const rawDate = extractTag(block, 'pubDate');
    const parsedDate = rawDate ? new Date(rawDate) : new Date();
    const pubDate = Number.isNaN(parsedDate.getTime())
      ? new Date().toISOString()
      : parsedDate.toISOString();

    const enclosureMatch = block.match(/<enclosure[^>]+url=["']([^"']+)["']/i);
    const enclosureUrl = enclosureMatch?.[1];

    if (guid && title && link) {
      items.push({
        guid,
        title,
        link,
        description,
        pubDate,
        ...(enclosureUrl ? { enclosureUrl } : {}),
      });
    }
  }

  return items;
}

/**
 * 30-minute Substack RSS cron poller stub (every 30 minutes).
 */
export async function handleRssCron(env: WorkerEnv): Promise<void> {
  const feedUrls = (env.SUBSTACK_FEED_URLS ?? '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);

  if (env.SYNDICATION_KV) {
    await env.SYNDICATION_KV.put('syndication:last_poll_at', new Date().toISOString());
  }

  if (feedUrls.length === 0 || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    logger.info('RSS poller skipped: no feed URLs or Supabase credentials configured');
    return;
  }

  const db = getSyndicationDbClient(env);
  const tenantId = '00000000-0000-0000-0000-000000000000';

  for (const feedUrl of feedUrls) {
    try {
      const response = await fetch(feedUrl);
      if (!response.ok) {
        logger.warn('Failed to fetch Substack RSS feed', { feedUrl, status: response.status });
        continue;
      }

      const xml = await response.text();
      const items = parseRssFeedXml(xml);
      const channels = await getActiveChannelConnections(db, tenantId);

      for (const item of items) {
        const alreadyProcessed = await isFeedItemProcessed(db, tenantId, item.guid);
        if (alreadyProcessed) continue;

        const post = await createPublicationPost(db, {
          tenant_id: tenantId,
          source_type: 'substack_rss',
          source_ref_id: item.guid,
          title: item.title,
          body: item.description || item.title,
          canonical_url: item.link,
          media_urls: item.enclosureUrl ? [item.enclosureUrl] : [],
          status: 'queued',
        });

        await recordFeedHistory(db, {
          tenant_id: tenantId,
          feed_url: feedUrl,
          item_guid: item.guid,
          item_url: item.link,
          title: item.title,
          published_at: item.pubDate,
          publication_post_id: post.id,
        });

        if (env.SYNDICATION_QUEUE && channels.length > 0) {
          await env.SYNDICATION_QUEUE.sendBatch(
            channels.map((ch) => {
              const excerpt = buildPlatformExcerpt({
                title: post.title,
                body: post.body,
                url: post.canonical_url,
                platform: ch.platform,
              });
              return {
                body: {
                  dispatch_id: crypto.randomUUID(),
                  post_id: post.id,
                  tenant_id: tenantId,
                  channel_connection_id: ch.id,
                  platform: ch.platform,
                  idempotency_key: `${post.id}:${ch.id}`,
                  attempt: 1,
                  payload: {
                    text: excerpt.text,
                    linkUrl: excerpt.linkUrl,
                    mediaUrls: post.media_urls,
                    threadChunks: excerpt.threadChunks,
                  },
                },
              };
            }),
          );
        }
      }
    } catch (err) {
      logger.error('Error polling RSS feed', {
        feedUrl,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
