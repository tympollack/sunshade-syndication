import { describe, expect, it } from 'vitest';
import { handleHealthRequest } from '../../apps/syndication-worker/src/routes/health.js';
import type { WorkerEnv } from '../../apps/syndication-worker/src/types.js';

describe('healthRoute', () => {
  const env: WorkerEnv = {
    SERVICE_NAME: 'sunshade-syndication',
    BUILD_TIME: '2026-11-12T00:00:00Z',
    INTERNAL_HEALTH_TOKEN: 'secret-health-token-xyz',
  };

  it('returns HTTP 200 with standard public healthcheck fields for unauthenticated requests', async () => {
    const request = new Request('https://publish-stag.sunshade.icu/api/health', {
      method: 'GET',
    });

    const response = await handleHealthRequest(request, env);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store, no-cache, must-revalidate');

    const body = (await response.json()) as Record<string, unknown>;
    expect(body['status']).toBe('healthy');
    expect(body['service']).toBe('sunshade-syndication');
    expect(body['buildTime']).toBe('2026-11-12T00:00:00Z');
    expect(body['timestamp']).toBeDefined();
    // Operational metrics must NOT be leaked to unauthenticated callers
    expect(body['queueDepth']).toBeUndefined();
    expect(body['activeChannels']).toBeUndefined();
    expect(body['lastPollAt']).toBeUndefined();
  });

  it('includes protected operational metrics when valid Bearer INTERNAL_HEALTH_TOKEN is supplied', async () => {
    const request = new Request('https://publish-stag.sunshade.icu/api/health', {
      method: 'GET',
      headers: {
        Authorization: 'Bearer secret-health-token-xyz',
      },
    });

    const response = await handleHealthRequest(request, env, {
      getOperationalMetrics: async () => ({
        queueDepth: 4,
        activeChannels: 7,
        lastPollAt: '2026-11-12T14:30:00.000Z',
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['status']).toBe('healthy');
    expect(body['queueDepth']).toBe(4);
    expect(body['activeChannels']).toBe(7);
    expect(body['lastPollAt']).toBe('2026-11-12T14:30:00.000Z');
  });

  it('omits operational metrics when Bearer token is invalid', async () => {
    const request = new Request('https://publish-stag.sunshade.icu/api/health', {
      method: 'GET',
      headers: {
        Authorization: 'Bearer wrong-token',
      },
    });

    const response = await handleHealthRequest(request, env, {
      getOperationalMetrics: async () => ({
        queueDepth: 99,
        activeChannels: 99,
        lastPollAt: '2026-11-12T14:30:00.000Z',
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['status']).toBe('healthy');
    expect(body['queueDepth']).toBeUndefined();
    expect(body['activeChannels']).toBeUndefined();
  });
});
