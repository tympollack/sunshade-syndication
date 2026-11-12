const textEncoder = new TextEncoder();

export type HmacPayload = string | ArrayBuffer | Uint8Array;

function toUint8Array(payload: HmacPayload): Uint8Array {
  if (typeof payload === 'string') {
    return textEncoder.encode(payload);
  }
  if (payload instanceof Uint8Array) {
    return payload;
  }
  return new Uint8Array(payload);
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    return null;
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Constant-time byte array comparison to prevent timing side-channel leaks.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.byteLength; i += 1) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

async function importHmacKey(secret: string, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usages,
  );
}

/**
 * Computes the lowercase hex HMAC-SHA256 digest using Web Crypto API.
 */
export async function computeHmacSha256Hex(
  payload: HmacPayload,
  secret: string,
): Promise<string> {
  if (!secret) {
    throw new Error('HMAC secret must not be empty.');
  }
  const key = await importHmacKey(secret, ['sign']);
  const rawBytes = toUint8Array(payload);
  const buffer = rawBytes.buffer.slice(
    rawBytes.byteOffset,
    rawBytes.byteOffset + rawBytes.byteLength,
  ) as ArrayBuffer;
  const signature = await crypto.subtle.sign('HMAC', key, buffer);
  return bytesToHex(new Uint8Array(signature));
}

/**
 * Produces a `sha256=<hex>` header value for `X-SunShade-Signature-256`.
 */
export async function signHmacSha256Header(
  payload: HmacPayload,
  secret: string,
): Promise<string> {
  const hex = await computeHmacSha256Hex(payload, secret);
  return `sha256=${hex}`;
}

/**
 * Timing-safe verification of `X-SunShade-Signature-256` (`sha256=<64-hex>`)
 * using native Web Crypto `crypto.subtle.verify` + constant-time guard.
 */
export async function verifyHmacSha256Signature(
  payload: HmacPayload,
  signatureHeader: string | null | undefined,
  secret: string,
): Promise<boolean> {
  if (!secret || !signatureHeader) {
    return false;
  }

  const trimmed = signatureHeader.trim();
  if (!trimmed.toLowerCase().startsWith('sha256=')) {
    return false;
  }

  const hexDigest = trimmed.slice('sha256='.length);
  const providedBytes = hexToBytes(hexDigest);
  if (!providedBytes || providedBytes.byteLength !== 32) {
    return false;
  }

  try {
    const key = await importHmacKey(secret, ['verify']);
    const rawBytes = toUint8Array(payload);
    const payloadBuffer = rawBytes.buffer.slice(
      rawBytes.byteOffset,
      rawBytes.byteOffset + rawBytes.byteLength,
    ) as ArrayBuffer;
    const sigBuffer = providedBytes.buffer.slice(
      providedBytes.byteOffset,
      providedBytes.byteOffset + providedBytes.byteLength,
    ) as ArrayBuffer;

    return await crypto.subtle.verify('HMAC', key, sigBuffer, payloadBuffer);
  } catch {
    return false;
  }
}
