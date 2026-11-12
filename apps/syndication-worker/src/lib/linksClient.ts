import type { WorkerEnv } from '../types.js';
import { logger } from './logger.js';

export interface CreateShortLinkParams {
  destinationUrl: string;
  slug?: string;
  tenantId?: string;
  title?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
}

export interface CreateShortLinkResult {
  shortUrl: string;
  slug: string;
  destinationUrl: string;
}

/**
 * Client wrapper calling SunShade Links (`links.sunshade.icu` or `links-stag.sunshade.icu`).
 * Falls back safely to the raw destination URL if the service is unreachable.
 */
export class LinksClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;

  constructor(env: WorkerEnv) {
    this.baseUrl = (env.LINKS_API_URL ?? 'https://links-stag.sunshade.icu').replace(/\/+$/, '');
    this.apiKey = env.SUNSHADE_MASTER_API_KEY;
  }

  async createShortLink(params: CreateShortLinkParams): Promise<CreateShortLinkResult | null> {
    const endpoint = `${this.baseUrl}/api/v1/links`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
      headers['X-SunShade-API-Key'] = this.apiKey;
    }

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          url: params.destinationUrl,
          slug: params.slug,
          tenant_id: params.tenantId,
          title: params.title,
          utm_source: params.utmSource,
          utm_medium: params.utmMedium,
          utm_campaign: params.utmCampaign,
        }),
      });

      if (!response.ok) {
        logger.warn('Links service responded with non-2xx status', {
          status: response.status,
          endpoint,
        });
        return null;
      }

      const body = (await response.json()) as { short_url?: string; slug?: string };
      if (!body.short_url) {
        return null;
      }

      return {
        shortUrl: body.short_url,
        slug: body.slug ?? '',
        destinationUrl: params.destinationUrl,
      };
    } catch (err) {
      logger.warn('Failed to contact links service', {
        endpoint,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}
