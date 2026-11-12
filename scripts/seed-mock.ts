import { createClient } from '@supabase/supabase-js';

const TENANT_ZERO_ID = '00000000-0000-0000-0000-000000000000';

async function main(): Promise<void> {
  const supabaseUrl = process.env['SUPABASE_URL'] ?? 'http://127.0.0.1:54321';
  const serviceRoleKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];

  if (!serviceRoleKey) {
    console.error(
      'Missing SUPABASE_SERVICE_ROLE_KEY. Copy .env.example to .env and set local Docker Supabase credentials.',
    );
    process.exit(1);
  }

  const db = createClient(supabaseUrl, serviceRoleKey, {
    db: { schema: 'syndication' },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const dummyChannels = [
    {
      id: '11111111-1111-4111-8111-111111111101',
      tenant_id: TENANT_ZERO_ID,
      platform: 'bluesky',
      account_handle: 'sunshade-dev.bsky.social',
      account_urn: 'did:plc:sunshadedevmock0000000001',
      status: 'active',
      metadata: { environment: 'local-mock' },
    },
    {
      id: '11111111-1111-4111-8111-111111111102',
      tenant_id: TENANT_ZERO_ID,
      platform: 'linkedin',
      account_handle: 'sunshade-systems-dev',
      account_urn: 'urn:li:organization:99990001',
      status: 'active',
      metadata: { environment: 'local-mock' },
    },
    {
      id: '11111111-1111-4111-8111-111111111103',
      tenant_id: TENANT_ZERO_ID,
      platform: 'x',
      account_handle: '@SunShadeDev',
      account_urn: 'x:user:99990001',
      status: 'active',
      metadata: { environment: 'local-mock' },
    },
    {
      id: '11111111-1111-4111-8111-111111111104',
      tenant_id: TENANT_ZERO_ID,
      platform: 'meta',
      account_handle: 'SunShadeSystemsDev',
      account_urn: 'fb:page:99990001',
      status: 'active',
      metadata: { environment: 'local-mock' },
    },
  ];

  const { data: channelsData, error: channelsError } = await db
    .from('channel_connections')
    .upsert(dummyChannels, { onConflict: 'id' })
    .select('id, platform, account_handle');

  if (channelsError) {
    throw new Error(`Failed to seed channel_connections: ${channelsError.message}`);
  }

  const { data: postData, error: postError } = await db
    .from('publication_posts')
    .upsert(
      {
        id: '22222222-2222-4222-8222-222222222201',
        tenant_id: TENANT_ZERO_ID,
        source_type: 'manual',
        source_ref_id: 'SEED-001',
        title: 'Local Dev Seed: SunShade Syndication Pipeline',
        body: 'Sample development post seeded for Tenant 0 local testing.',
        canonical_url: 'https://publish-stag.sunshade.icu/posts/seed-001',
        short_url: 'https://links-stag.sunshade.icu/seed001',
        media_urls: [],
        status: 'draft',
      },
      { onConflict: 'id' },
    )
    .select('id, title');

  if (postError) {
    throw new Error(`Failed to seed publication_posts: ${postError.message}`);
  }

  console.log(
    JSON.stringify({
      seeded: true,
      tenantId: TENANT_ZERO_ID,
      channelsCount: channelsData?.length ?? 0,
      postsCount: postData?.length ?? 0,
    }),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
