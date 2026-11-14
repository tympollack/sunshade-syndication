import type { ChannelDispatchJob } from '@digitalcanopy/syndication-core';
import type { WorkerEnv } from './types.js';
import { handleHealthRequest } from './routes/health.js';
import { handleTrackerWebhook } from './routes/trackerWebhook.js';
import { handleQueueBatch } from './workers/dispatchWorker.js';
import { handleRssCron } from './workers/rssPollerWorker.js';
import { handleTokenRefreshCron } from './workers/tokenRefreshWorker.js';
import { logger } from './lib/logger.js';

const worker: ExportedHandler<WorkerEnv, ChannelDispatchJob> = {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/api/health') {
      return handleHealthRequest(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/v1/webhooks/tracker') {
      return handleTrackerWebhook(request, env);
    }

    return new Response(JSON.stringify({ error: 'Not Found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  },

  async scheduled(controller: ScheduledController, env: WorkerEnv): Promise<void> {
    logger.info('Scheduled cron trigger invoked', { cron: controller.cron });

    if (controller.cron === '0 6 * * *') {
      await handleTokenRefreshCron(env);
      return;
    }

    // Run 30-minute Substack RSS poller alongside short-lived (2-hr) token refresh cycle
    await Promise.allSettled([
      handleRssCron(env),
      handleTokenRefreshCron(env, { horizonMs: 2 * 60 * 60 * 1000 }),
    ]);
  },

  async queue(batch: MessageBatch<ChannelDispatchJob>, env: WorkerEnv): Promise<void> {
    await handleQueueBatch(batch, env);
  },
};

export default worker;
