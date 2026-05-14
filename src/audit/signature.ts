/**
 * ed25519 signatures for audit-log records. SPEC §2.6.
 *
 * The signature is computed over the canonical bytes of the record with
 * `signature: null`. Library uses Node's built-in `crypto.sign` /
 * `crypto.verify` for ed25519 — no native deps.
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';

import type { AuditRecord } from '../types.js';
import { canonicalizeForHash } from './chain.js';

const PREFIX = 'ed25519:';

/** Generated key pair. */
export interface Ed25519KeyPair {
  privateKey: KeyObject;
  publicKey: KeyObject;
}

/** Generate a fresh ed25519 key pair. */
export function generateEd25519KeyPair(): Ed25519KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey };
}

/** Load an ed25519 private key from a PEM string or Buffer. */
export function loadPrivateKey(pem: string | Buffer): KeyObject {
  return createPrivateKey(pem);
}

/** Load an ed25519 public key from a PEM string or Buffer. */
export function loadPublicKey(pem: string | Buffer): KeyObject {
  return createPublicKey(pem);
}

/**
 * Sign a record's canonical bytes. Returns `ed25519:<base64url>` per SPEC §2.6.
 *
 * The record passed in MUST have `signature: null` (canonicalizeForHash strips
 * it, but we keep the convention clean).
 */
export function signRecord(record: AuditRecord, privateKey: KeyObject): string {
  const canonical = canonicalizeForHash(record);
  const sig = sign(null, canonical, privateKey);
  return PREFIX + base64url(sig);
}

/**
 * Verify a record's signature. Returns true iff the signature matches the
 * record's canonical bytes under the given public key.
 *
 * Records without a signature field (`null`) return false — caller must
 * decide whether to allow unsigned records (typically only at compatibility
 * boundaries).
 */
export function verifyRecord(record: AuditRecord, publicKey: KeyObject): boolean {
  if (record.signature == null) return false;
  if (typeof record.signature !== 'string') return false;
  if (!record.signature.startsWith(PREFIX)) return false;
  const sigBytes = base64urlDecode(record.signature.slice(PREFIX.length));
  if (sigBytes === null) return false;
  const canonical = canonicalizeForHash(record);
  try {
    return verify(null, canonical, publicKey, sigBytes);
  } catch {
    return false;
  }
}

// ---- base64url helpers --------------------------------------------------

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(s: string): Buffer | null {
  // Validate characters — Node Buffer.from is permissive otherwise.
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const normalized = s.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64');
}

export { PREFIX as SIGNATURE_PREFIX };
