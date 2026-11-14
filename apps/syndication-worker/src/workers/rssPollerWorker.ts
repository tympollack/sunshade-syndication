import {
  buildPlatformExcerpt,
  normalizeCopy,
  type ChannelDispatchJob,
} from '@digitalcanopy/syndication-core';
import type { WorkerEnv } from '../types.js';
import { logger } from '../lib/logger.js';
import { LinksClient } from '../lib/linksClient.js';
import {
  createPublicationPost,
  getActiveChannelConnections,
  getSyndicationDbClient,
  isFeedItemProcessed,
  recordFeedHistory,
  type SyndicationDbClient,
} from '../lib/supabase.js';

export interface ParsedRssItem {
  guid: string;
  title: string;
  link: string;
  description: string;
  pubDate: string;
  enclosureUrl?: string;
}

export interface RssCronOptions {
  now?: () => Date;
  db?: SyndicationDbClient;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  linksClient?: LinksClient;
}

export interface RssPollerSummary {
  feedsPolled: number;
  itemsFound: number;
  itemsProcessed: number;
  itemsSkipped: number;
  shortlinksMinted: number;
  postsQueued: number;
}

function extractTag(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  const raw = match?.[1] ?? '';
  return raw.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/i, '$1').trim();
}

/**
 * Minimal deterministic RSS 2.0 XML parser for Substack feeds.
 * Correctly extracts CDATA sections, HTML entity-encoded descriptions,
 * enclosures / media thumbnails, and RFC-822 / ISO-8601 publication timestamps.
 */
export function parseRssFeedXml(xml: string): ParsedRssItem[] {
  const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/gi);
  const items: ParsedRssItem[] = [];

  for (const match of itemMatches) {
    const block = match[1] ?? '';
    const rawTitle = extractTag(block, 'title');
    const title = normalizeCopy(rawTitle);
    const link = extractTag(block, 'link');
    const guid = extractTag(block, 'guid') || link;
    const rawDescription = extractTag(block, 'description') || extractTag(block, 'content:encoded');
    const description = normalizeCopy(rawDescription);
    const rawDate = extractTag(block, 'pubDate');
    const parsedDate = rawDate ? new Date(rawDate) : new Date();
    const pubDate = Number.isNaN(parsedDate.getTime())
      ? new Date().toISOString()
      : parsedDate.toISOString();

    const enclosureMatch = block.match(/<(?:enclosure|media:content)[^>]+url=["']([^"']+)["']/i);
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
 * 30-minute Substack RSS cron poller.
 * Scans configured Substack feeds, deduplicates against `syndication.feed_history`
 * and `syndication.publication_posts`, mints platform-attributed shortlinks via
 * `links.sunshade.icu/api/v1/links`, and broadcasts to active channels.
 */
export async function handleRssCron(
  env: WorkerEnv,
  options: RssCronOptions = {},
): Promise<RssPollerSummary> {
  const summary: RssPollerSummary = {
    feedsPolled: 0,
    itemsFound: 0,
    itemsProcessed: 0,
    itemsSkipped: 0,
    shortlinksMinted: 0,
    postsQueued: 0,
  };

  const feedUrls = (env.SUBSTACK_FEED_URLS ?? '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);

  if (env.SYNDICATION_KV) {
    const nowIso = (options.now?.() ?? new Date()).toISOString();
    await env.SYNDICATION_KV.put('syndication:last_poll_at', nowIso);
  }

  if (feedUrls.length === 0 || (!options.db && (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY))) {
    logger.info('RSS poller skipped: no feed URLs or Supabase credentials configured');
    return summary;
  }

  const db = options.db ?? getSyndicationDbClient(env);
  const fetchFn = options.fetch ?? fetch;
  const linksClient = options.linksClient ?? new LinksClient(env);
  const tenantId = env.DEFAULT_TENANT_ID ?? '00000000-0000-0000-0000-000000000000';

  for (const feedUrl of feedUrls) {
    summary.feedsPolled += 1;
    try {
      const response = await fetchFn(feedUrl);
      if (!response.ok) {
        logger.warn('Failed to fetch Substack RSS feed', { feedUrl, status: response.status });
        continue;
      }

      const xml = await response.text();
      const items = parseRssFeedXml(xml);
      summary.itemsFound += items.length;

      const channels = await getActiveChannelConnections(db, tenantId);

      for (const item of items) {
        const alreadyProcessed = await isFeedItemProcessed(db, tenantId, item.guid, feedUrl);
        if (alreadyProcessed) {
          summary.itemsSkipped += 1;
          continue;
        }

        // Mint post canonical shortlink via links service (falls back safely if unavailable)
        let postShortUrl: string | undefined;
        try {
          const postShortLink = await linksClient.createShortLink({
            destinationUrl: item.link,
            tenantId,
            title: item.title,
            utmCampaign: 'substack_rss',
          });
          if (postShortLink?.shortUrl) {
            postShortUrl = postShortLink.shortUrl;
            summary.shortlinksMinted += 1;
          }
        } catch (err) {
          logger.warn('Failed to mint post-level shortlink', {
            itemGuid: item.guid,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        const post = await createPublicationPost(db, {
          tenant_id: tenantId,
          source_type: 'substack_rss',
          source_ref_id: item.guid,
          title: item.title,
          body: item.description || item.title,
          canonical_url: item.link,
          short_url: postShortUrl,
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
        summary.itemsProcessed += 1;

        if (env.SYNDICATION_QUEUE && channels.length > 0) {
          const queueMessages: Array<{ body: ChannelDispatchJob }> = [];

          for (const ch of channels) {
            let channelShortUrl = postShortUrl;
            try {
              const channelShortLink = await linksClient.createShortLink({
                destinationUrl: item.link,
                tenantId,
                title: item.title,
                utmSource: ch.platform,
                utmMedium: 'social',
                utmCampaign: 'substack_rss',
              });
              if (channelShortLink?.shortUrl) {
                channelShortUrl = channelShortLink.shortUrl;
                summary.shortlinksMinted += 1;
              }
            } catch (err) {
              logger.warn('Failed to mint channel-level shortlink; falling back', {
                itemGuid: item.guid,
                platform: ch.platform,
                error: err instanceof Error ? err.message : String(err),
              });
            }

            const excerpt = buildPlatformExcerpt({
              title: post.title,
              body: post.body,
              url: post.canonical_url,
              shortUrl: channelShortUrl,
              platform: ch.platform,
              campaign: 'substack_rss',
            });

            queueMessages.push({
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
            });
          }

          await env.SYNDICATION_QUEUE.sendBatch(queueMessages);
          summary.postsQueued += queueMessages.length;
        }
      }
    } catch (err) {
      logger.error('Error polling RSS feed', {
        feedUrl,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('Completed Substack RSS polling cycle', { ...summary });
  return summary;
}
