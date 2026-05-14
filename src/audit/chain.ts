/**
 * Audit-log hash chain. SPEC §2.5.
 *
 * Stateless helpers; no I/O.
 */

import { createHash } from 'node:crypto';

import type { AuditRecord } from '../types.js';

/** The genesis hash that the first record's prev_hash points to. */
export const GENESIS_HASH = 'sha256:0';

/**
 * Compute the canonical hash of a record. The record's own `prev_hash` is
 * included; the `signature` is NOT, because signatures are computed over the
 * record with `signature: null` (so the signature itself doesn't change the
 * record's identity in the chain).
 *
 * Canonical-form JSON: keys sorted lexicographically; no extra whitespace;
 * Unicode normalized to NFC.
 */
export function computeRecordHash(record: AuditRecord): string {
  const canonical = canonicalizeForHash(record);
  return 'sha256:' + createHash('sha256').update(canonical).digest('hex');
}

/**
 * Produce the canonical UTF-8 bytes of a record for hashing. Strips
 * `signature` (signatures are over the unsigned record). Keys sorted.
 */
export function canonicalizeForHash(record: AuditRecord): Buffer {
  const { signature: _signature, ...rest } = record;
  return Buffer.from(canonicalJsonStringify(rest), 'utf-8');
}

/**
 * Stable JSON.stringify: sort keys recursively. Matches Python's
 * `json.dumps(..., sort_keys=True, separators=(',', ':'))` byte-for-byte for
 * the field types we use (strings, numbers, booleans, null, arrays, objects).
 */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('non-finite numbers cannot be canonicalized');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJsonStringify).join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const v = obj[k];
      if (v === undefined) continue;
      parts.push(JSON.stringify(k) + ':' + canonicalJsonStringify(v));
    }
    return '{' + parts.join(',') + '}';
  }
  throw new TypeError(`cannot canonicalize value of type ${typeof value}`);
}
