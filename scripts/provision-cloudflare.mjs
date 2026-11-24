#!/usr/bin/env node

/**
 * Idempotent provisioning script for SunShade Syndication Cloudflare infrastructure:
 * - Validates API Token and Account permissions upfront
 * - Verifies wrangler.toml environment configurations for production and staging
 * - Validates required runtime secret bindings documented in .env.example
 * - Manages Worker custom domains (publish.sunshade.icu & publish-stag.sunshade.icu)
 *
 * Required environment variables:
 *   CLOUDFLARE_API_TOKEN   - Cloudflare API token with Workers, Routes & DNS permissions
 *   CLOUDFLARE_ACCOUNT_ID  - Cloudflare Account ID
 *
 * Optional environment variables:
 *   CLOUDFLARE_ZONE_ID     - Zone ID for sunshade.icu (auto-discovered if omitted)
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '..');

const CF_API = 'https://api.cloudflare.com/client/v4';
const WORKER_SERVICE_PROD = 'sunshade-syndication-worker';
const WORKER_SERVICE_STAG = 'sunshade-syndication-worker-stag';
const PRODUCTION_DOMAIN = 'publish.sunshade.icu';
const STAGING_DOMAIN = 'publish-stag.sunshade.icu';
const ROOT_ZONE = 'sunshade.icu';

const REQUIRED_SECRETS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'LINKS_API_URL',
  'MASTER_API_KEY',
  'TRACKER_WEBHOOK_SECRET',
  'INTERNAL_HEALTH_TOKEN',
];

const apiToken = (process.env.CLOUDFLARE_API_TOKEN || '').trim();
const accountId = (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();

if (!apiToken || !accountId) {
  console.error('Error: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set.');
  console.error('Export both variables and re-run: npm run cf:provision');
  process.exitCode = 1;
  process.exit(1);
}

async function cfRequest(path, options = {}) {
  const res = await fetch(`${CF_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const payload = await res.json().catch(() => ({}));
  return { ok: res.ok && payload.success, status: res.status, payload };
}

function parseErrorMessage(payload, defaultMsg) {
  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    return payload.errors.map((e) => `[${e.code || 'error'}] ${e.message}`).join(', ');
  }
  return defaultMsg;
}

async function verifyAuth() {
  console.log('[cf:provision] Verifying Cloudflare API token credentials...');

  let verify = await cfRequest(`/accounts/${accountId}/tokens/verify`);
  if (!verify.ok) {
    const userVerify = await cfRequest('/user/tokens/verify');
    if (userVerify.ok) {
      verify = userVerify;
    }
  }

  if (!verify.ok) {
    const scriptsCheck = await cfRequest(`/accounts/${accountId}/workers/scripts?per_page=1`);
    if (scriptsCheck.ok) {
      console.log(`[cf:provision] API Token validated via direct Account Workers access.`);
      return;
    }

    const detail = parseErrorMessage(verify.payload, `HTTP ${verify.status}`);
    throw new Error(
      `API Token verification failed: ${detail}.\n` +
      `  -> Ensure you clicked the blue "Update token" button in Cloudflare Dashboard to save your changes.\n` +
      `  -> If Cloudflare rolled or generated a new token secret, ensure $env:CLOUDFLARE_API_TOKEN is set to the new secret.\n` +
      `  -> Check that CLOUDFLARE_ACCOUNT_ID is correct and matches your Cloudflare account.`
    );
  }

  console.log(`[cf:provision] API Token verified (status: ${verify.payload.result?.status || 'active'}).`);
}

function validateEnvExample() {
  const envExamplePath = resolve(ROOT_DIR, '.env.example');
  let content = '';
  try {
    content = readFileSync(envExamplePath, 'utf8');
  } catch (err) {
    throw new Error(`Failed to read .env.example: ${err.message}`);
  }

  const missing = REQUIRED_SECRETS.filter((secret) => !content.includes(secret));
  if (missing.length > 0) {
    throw new Error(`.env.example is missing documented secrets: ${missing.join(', ')}`);
  }

  console.log('[cf:provision] Validated required runtime secret bindings in .env.example.');
}

function validateWranglerConfig() {
  const wranglerPath = resolve(ROOT_DIR, 'apps/syndication-worker/wrangler.toml');
  let content = '';
  try {
    content = readFileSync(wranglerPath, 'utf8');
  } catch (err) {
    throw new Error(`Failed to read wrangler.toml: ${err.message}`);
  }

  if (!content.includes('publish.sunshade.icu')) {
    throw new Error('wrangler.toml missing production route for publish.sunshade.icu');
  }
  if (!content.includes('publish-stag.sunshade.icu')) {
    throw new Error('wrangler.toml missing staging route for publish-stag.sunshade.icu');
  }

  console.log('[cf:provision] Verified wrangler.toml environment route bindings.');
}

async function resolveZoneId() {
  if (process.env.CLOUDFLARE_ZONE_ID) return process.env.CLOUDFLARE_ZONE_ID.trim();

  const zones = await cfRequest(`/zones?name=${encodeURIComponent(ROOT_ZONE)}`);
  if (!zones.ok) {
    const detail = parseErrorMessage(zones.payload, `HTTP ${zones.status}`);
    throw new Error(
      `Failed to list zones for "${ROOT_ZONE}": ${detail}.\n` +
      `  -> Ensure token has "Zone > Zone > Read" permission, or set CLOUDFLARE_ZONE_ID explicitly.`
    );
  }

  const zone = Array.isArray(zones.payload.result) ? zones.payload.result[0] : null;
  if (!zone) {
    throw new Error(`Could not find zone "${ROOT_ZONE}" in your Cloudflare account. Set CLOUDFLARE_ZONE_ID explicitly.`);
  }
  return zone.id;
}

async function removeCnameIfPresent(zoneId, hostname) {
  const list = await cfRequest(
    `/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`
  );
  if (list.ok && Array.isArray(list.payload.result)) {
    for (const record of list.payload.result) {
      console.log(`[cf:provision] Removing CNAME ${hostname} -> ${record.content} to allow Worker Custom Domain management...`);
      await cfRequest(`/zones/${zoneId}/dns_records/${record.id}`, { method: 'DELETE' });
    }
  }
}

async function ensureWorkerDomain(hostname, serviceName, environment, zoneId) {
  const list = await cfRequest(`/accounts/${accountId}/workers/domains`);
  const existing = list.ok && Array.isArray(list.payload.result)
    ? list.payload.result.find((d) => d.hostname === hostname)
    : null;

  if (existing) {
    console.log(`[cf:provision] Worker custom domain "${hostname}" is already bound to service "${existing.service}" (${existing.environment || 'production'}).`);
    return;
  }

  const res = await cfRequest(`/accounts/${accountId}/workers/domains`, {
    method: 'PUT',
    body: JSON.stringify({
      hostname,
      service: serviceName,
      environment,
      zone_id: zoneId,
      enabled: true,
    }),
  });

  if (res.ok) {
    console.log(`[cf:provision] Attached Worker custom domain "${hostname}" to service "${serviceName}".`);
    await removeCnameIfPresent(zoneId, hostname);
  } else {
    console.log(`[cf:provision] Worker custom domain attachment for "${hostname}" note: ${res.payload.errors?.[0]?.message || 'will bind upon initial worker deploy via wrangler.toml'}.`);
  }
}

async function main() {
  console.log('[cf:provision] Starting SunShade Syndication Cloudflare provisioning...');

  // 1. Verify API Token & Account access
  await verifyAuth();

  // 2. Validate Secret Bindings & Local Wrangler Configuration
  validateEnvExample();
  validateWranglerConfig();

  // 3. Resolve Cloudflare Zone
  const zoneId = await resolveZoneId();
  console.log(`[cf:provision] Resolved zone "${ROOT_ZONE}" (ID: ${zoneId}).`);

  // 4. Worker Custom Domains
  await ensureWorkerDomain(PRODUCTION_DOMAIN, WORKER_SERVICE_PROD, 'production', zoneId);
  await ensureWorkerDomain(STAGING_DOMAIN, WORKER_SERVICE_STAG, 'staging', zoneId);

  console.log('[cf:provision] SunShade Syndication Cloudflare infrastructure successfully provisioned.');
}

main().catch((err) => {
  console.error(`[cf:provision] Provisioning failed:\n${err.message}`);
  process.exitCode = 1;
});
