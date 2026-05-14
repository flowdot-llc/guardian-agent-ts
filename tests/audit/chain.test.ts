import { describe, expect, it } from 'vitest';

import {
  GENESIS_HASH,
  canonicalJsonStringify,
  canonicalizeForHash,
  computeRecordHash,
} from '../../src/audit/chain.js';
import type { AuditRecord } from '../../src/types.js';
import { SPEC_VERSION } from '../../src/types.js';

function baseRecord(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    v: SPEC_VERSION,
    event_id: 'evt_01HXYZ',
    ts: '2026-05-13T23:45:12.345Z',
    agent_id: 'agent_x',
    session_id: 'sess_y',
    kind: 'tool_call',
    status: 'pending',
    initiator: 'agent',
    prev_hash: GENESIS_HASH,
    signature: null,
    ...overrides,
  };
}

describe('canonicalJsonStringify', () => {
  it('serializes primitives', () => {
    expect(canonicalJsonStringify(null)).toBe('null');
    expect(canonicalJsonStringify(true)).toBe('true');
    expect(canonicalJsonStringify(false)).toBe('false');
    expect(canonicalJsonStringify(42)).toBe('42');
    expect(canonicalJsonStringify('hi')).toBe('"hi"');
  });

  it('sorts object keys lexicographically', () => {
    expect(canonicalJsonStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJsonStringify({ z: { y: 1, x: 2 } })).toBe('{"z":{"x":2,"y":1}}');
  });

  it('serializes arrays preserving order', () => {
    expect(canonicalJsonStringify([3, 2, 1])).toBe('[3,2,1]');
  });

  it('omits undefined values', () => {
    expect(canonicalJsonStringify({ a: 1, b: undefined, c: 2 })).toBe('{"a":1,"c":2}');
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalJsonStringify(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJsonStringify(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });

  it('rejects unsupported types', () => {
    expect(() => canonicalJsonStringify(() => 0)).toThrow(TypeError);
    expect(() => canonicalJsonStringify(Symbol('s'))).toThrow(TypeError);
    expect(() => canonicalJsonStringify(BigInt(1))).toThrow(TypeError);
  });
});

describe('canonicalizeForHash', () => {
  it('strips signature field', () => {
    const r = baseRecord({ signature: 'ed25519:xxx' });
    const buf = canonicalizeForHash(r);
    expect(buf.toString('utf-8')).not.toContain('signature');
  });

  it('produces stable bytes regardless of input order', () => {
    const a = baseRecord({ signature: null });
    const b = { ...a };
    expect(canonicalizeForHash(a).equals(canonicalizeForHash(b))).toBe(true);
  });
});

describe('computeRecordHash', () => {
  it('produces a deterministic sha256 hash', () => {
    const r = baseRecord();
    const h1 = computeRecordHash(r);
    const h2 = computeRecordHash(r);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('changes when any field changes', () => {
    const a = baseRecord();
    const b = baseRecord({ status: 'executed' });
    expect(computeRecordHash(a)).not.toBe(computeRecordHash(b));
  });

  it('does not change when signature is added or removed', () => {
    const unsigned = baseRecord({ signature: null });
    const signed = baseRecord({ signature: 'ed25519:abc' });
    expect(computeRecordHash(unsigned)).toBe(computeRecordHash(signed));
  });
});

describe('GENESIS_HASH', () => {
  it('is the documented constant', () => {
    expect(GENESIS_HASH).toBe('sha256:0');
  });
});
