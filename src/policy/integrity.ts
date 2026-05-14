/**
 * HMAC-SHA256 integrity for policy files. SPEC §3.5.
 *
 * Signatures are produced over the canonical UTF-8 bytes of the policy data,
 * using a 32-byte site key.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SignedPolicyFile {
  version: 1;
  signed_at: string;
  signature: string; // base64
  data: string; // canonical-form YAML or JSON string
}

/** Compute HMAC-SHA256 over `data` using `key`. Returns base64. */
export function signPayload(data: string | Buffer, key: Buffer): string {
  const hmac = createHmac('sha256', key);
  hmac.update(typeof data === 'string' ? Buffer.from(data, 'utf-8') : data);
  return hmac.digest('base64');
}

/** Constant-time HMAC verification. Returns true iff the signature matches. */
export function verifyPayload(
  data: string | Buffer,
  signature: string,
  key: Buffer,
): boolean {
  const expected = signPayload(data, key);
  const expectedBuf = Buffer.from(expected, 'base64');
  let providedBuf: Buffer;
  /* c8 ignore start */
  try {
    providedBuf = Buffer.from(signature, 'base64');
  } catch {
    return false;
  }
  /* c8 ignore stop */
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}
