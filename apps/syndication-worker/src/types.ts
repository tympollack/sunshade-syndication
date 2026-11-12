import type { ChannelDispatchJob } from '@digitalcanopy/syndication-core';

export interface WorkerEnv {
  SERVICE_NAME?: string;
  BUILD_TIME?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  LINKS_API_URL?: string;
  SUNSHADE_MASTER_API_KEY?: string;
  TRACKER_WEBHOOK_SECRET?: string;
  INTERNAL_HEALTH_TOKEN?: string;
  SUBSTACK_FEED_URLS?: string;
  SYNDICATION_KV?: KVNamespace;
  SYNDICATION_QUEUE?: Queue<ChannelDispatchJob>;
}
