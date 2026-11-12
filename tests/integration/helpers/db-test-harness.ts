import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface DbHarnessContext {
  available: boolean;
  skipReason?: string;
  db?: SupabaseClient;
  anonDb?: SupabaseClient;
  testTenantId: string;
}

const DEFAULT_LOCAL_URL = 'http://127.0.0.1:54321';

/**
 * Checks connectivity to local Docker Supabase and verifies `syndication.*` schema exposure.
 * Returns a diagnostic `skipReason` if local Docker is stopped or migration is not yet applied.
 */
export async function initSyndicationDbHarness(): Promise<DbHarnessContext> {
  const supabaseUrl = process.env['SUPABASE_URL'] ?? DEFAULT_LOCAL_URL;
  const serviceRoleKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
  const anonKey = process.env['SUPABASE_ANON_KEY'];
  const testTenantId = crypto.randomUUID();

  if (!serviceRoleKey) {
    return {
      available: false,
      skipReason:
        'SUPABASE_SERVICE_ROLE_KEY is not set; skipping local Docker Supabase integration tests.',
      testTenantId,
    };
  }

  const db = createClient(supabaseUrl, serviceRoleKey, {
    db: { schema: 'syndication' },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const { error } = await db
      .from('channel_connections')
      .select('id', { count: 'exact', head: true });

    if (error) {
      const msg = error.message || '';
      if (msg.includes('schema must be one of') || msg.includes('does not exist')) {
        return {
          available: false,
          skipReason:
            'Schema `syndication` is not yet migrated in sunshade-db-platform on local Docker Supabase. Apply migrations first.',
          testTenantId,
        };
      }
      return {
        available: false,
        skipReason: `Local Docker Supabase probe failed (${supabaseUrl}): ${msg}`,
        testTenantId,
      };
    }

    const anonDb = anonKey
      ? createClient(supabaseUrl, anonKey, {
          db: { schema: 'syndication' },
          auth: { persistSession: false, autoRefreshToken: false },
        })
      : undefined;

    return {
      available: true,
      db,
      anonDb,
      testTenantId,
    };
  } catch (err) {
    return {
      available: false,
      skipReason: `Local Docker Supabase unreachable at ${supabaseUrl}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      testTenantId,
    };
  }
}

/**
 * Cleans up test fixtures created for `testTenantId`.
 */
export async function cleanupSyndicationTestTenant(
  db: SupabaseClient | undefined,
  testTenantId: string,
): Promise<void> {
  if (!db) return;

  await db.from('feed_history').delete().eq('tenant_id', testTenantId);
  await db.from('publication_posts').delete().eq('tenant_id', testTenantId);
  await db.from('channel_connections').delete().eq('tenant_id', testTenantId);
}
