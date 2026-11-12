import { describe, expect, it } from 'vitest';
import {
  computeHmacSha256Hex,
  signHmacSha256Header,
  timingSafeEqual,
  verifyHmacSha256Signature,
} from '@digitalcanopy/syndication-core';

describe('hmac', () => {
  const secret = 'super-secret-tracker-signing-key-12345';
  const payload = JSON.stringify({
    event: 'item.status_changed',
    tenant_id: '00000000-0000-0000-0000-000000000000',
    new_status: 'syndicated',
  });

  it('computes 64-character lowercase hex digest using Web Crypto', async () => {
    const hex = await computeHmacSha256Hex(payload, secret);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifies valid X-SunShade-Signature-256 header', async () => {
    const header = await signHmacSha256Header(payload, secret);
    expect(header).toMatch(/^sha256=[0-9a-f]{64}$/);

    const isValid = await verifyHmacSha256Signature(payload, header, secret);
    expect(isValid).toBe(true);
  });

  it('rejects tampered payloads', async () => {
    const header = await signHmacSha256Header(payload, secret);
    const tamperedPayload = payload.replace('syndicated', 'published');

    const isValid = await verifyHmacSha256Signature(tamperedPayload, header, secret);
    expect(isValid).toBe(false);
  });

  it('rejects incorrect secrets', async () => {
    const header = await signHmacSha256Header(payload, secret);
    const wrongSecret = 'another-secret-entirely';

    const isValid = await verifyHmacSha256Signature(payload, header, wrongSecret);
    expect(isValid).toBe(false);
  });

  it('rejects malformed header formats without throwing', async () => {
    expect(await verifyHmacSha256Signature(payload, null, secret)).toBe(false);
    expect(await verifyHmacSha256Signature(payload, '', secret)).toBe(false);
    expect(await verifyHmacSha256Signature(payload, 'plain-hex-without-sha256-prefix', secret)).toBe(false);
    expect(await verifyHmacSha256Signature(payload, 'sha256=invalid-non-hex-chars!!!', secret)).toBe(false);
    expect(await verifyHmacSha256Signature(payload, 'sha256=1234', secret)).toBe(false);
  });

  it('timingSafeEqual detects equality and length mismatches safely', () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 4]);
    const c = new Uint8Array([1, 2, 3, 5]);
    const d = new Uint8Array([1, 2, 3]);

    expect(timingSafeEqual(a, b)).toBe(true);
    expect(timingSafeEqual(a, c)).toBe(false);
    expect(timingSafeEqual(a, d)).toBe(false);
  });
});
