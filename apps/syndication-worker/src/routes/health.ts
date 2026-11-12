import { timingSafeEqual } from '@digitalcanopy/syndication-core';
import type { WorkerEnv } from '../types.js';
import { getSyndicationDbClient } from '../lib/supabase.js';

export interface OperationalHealthMetrics {
  queueDepth: number;
  activeChannels: number;
  lastPollAt: string | null;
}

export interface HealthRouteDeps {
  getOperationalMetrics?: (env: WorkerEnv) => Promise<OperationalHealthMetrics>;
}

const textEncoder = new TextEncoder();

function isAuthorizedHealthRequest(request: Request, expectedToken?: string): boolean {
  if (!expectedToken) {
    return false;
  }

  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false;
  }

  const providedToken = authHeader.slice('Bearer '.length).trim();
  const providedBytes = textEncoder.encode(providedToken);
  const expectedBytes = textEncoder.encode(expectedToken);

  return timingSafeEqual(providedBytes, expectedBytes);
}

async function defaultGetOperationalMetrics(env: WorkerEnv): Promise<OperationalHealthMetrics> {
  let queueDepth = 0;
  let activeChannels = 0;
  let lastPollAt: string | null = null;

  if (env.SYNDICATION_KV) {
    const [kvLastPoll, kvQueueDepth] = await Promise.all([
      env.SYNDICATION_KV.get('syndication:last_poll_at'),
      env.SYNDICATION_KV.get('syndication:queue_depth'),
    ]);
    lastPollAt = kvLastPoll;
    queueDepth = kvQueueDepth ? Number.parseInt(kvQueueDepth, 10) || 0 : 0;
  }

  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const db = getSyndicationDbClient(env);
      const { count, error } = await db
        .from('channel_connections')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'active');

      if (!error && typeof count === 'number') {
        activeChannels = count;
      }
    } catch {
      // Keep zero empty-state fallback if DB is temporarily unreachable
    }
  }

  return {
    queueDepth,
    activeChannels,
    lastPollAt,
  };
}

/**
 * Standardized `GET /api/health` handler conforming to `hub-admin-gateway` healthcheck contract.
 */
export async function handleHealthRequest(
  request: Request,
  env: WorkerEnv,
  deps: HealthRouteDeps = {},
): Promise<Response> {
  const basePayload = {
    status: 'healthy' as const,
    service: env.SERVICE_NAME ?? 'sunshade-syndication',
    buildTime: env.BUILD_TIME ?? 'unknown',
    timestamp: new Date().toISOString(),
  };

  const authorized = isAuthorizedHealthRequest(request, env.INTERNAL_HEALTH_TOKEN);
  const body = authorized
    ? {
        ...basePayload,
        ...(await (deps.getOperationalMetrics ?? defaultGetOperationalMetrics)(env)),
      }
    : basePayload;

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  });
}
