import { describe, expect, it } from 'vitest';

import {
  generateEd25519KeyPair,
  loadPrivateKey,
  loadPublicKey,
  signRecord,
  verifyRecord,
  SIGNATURE_PREFIX,
} from '../../src/audit/signature.js';
import { GENESIS_HASH } from '../../src/audit/chain.js';
import { SPEC_VERSION } from '../../src/types.js';
import type { AuditRecord } from '../../src/types.js';

function recordOf(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    v: SPEC_VERSION,
    event_id: 'evt_01HXYZ',
    ts: '2026-05-13T23:45:12.345Z',
    agent_id: 'a',
    session_id: 's',
    kind: 'tool_call',
    status: 'pending',
    initiator: 'agent',
    prev_hash: GENESIS_HASH,
    signature: null,
    ...overrides,
  };
}

describe('ed25519 signature round-trip', () => {
  it('signs and verifies a record', () => {
    const { privateKey, publicKey } = generateEd25519KeyPair();
    const r = recordOf();
    const sig = signRecord(r, privateKey);
    expect(sig.startsWith(SIGNATURE_PREFIX)).toBe(true);
    const signed = { ...r, signature: sig };
    expect(verifyRecord(signed, publicKey)).toBe(true);
  });

  it('detects modification of any record field', () => {
    const { privateKey, publicKey } = generateEd25519KeyPair();
    const r = recordOf();
    const sig = signRecord(r, privateKey);
    const tampered = { ...r, status: 'executed' as const, signature: sig };
    expect(verifyRecord(tampered, publicKey)).toBe(false);
  });

  it('rejects under a different public key', () => {
    const { privateKey } = generateEd25519KeyPair();
    const { publicKey } = generateEd25519KeyPair();
    const r = recordOf();
    const signed = { ...r, signature: signRecord(r, privateKey) };
    expect(verifyRecord(signed, publicKey)).toBe(false);
  });

  it('returns false when signature is null', () => {
    const { publicKey } = generateEd25519KeyPair();
    expect(verifyRecord(recordOf({ signature: null }), publicKey)).toBe(false);
  });

  it('returns false when signature is not a string', () => {
    const { publicKey } = generateEd25519KeyPair();
    const r = { ...recordOf(), signature: 7 as unknown as string };
    expect(verifyRecord(r, publicKey)).toBe(false);
  });

  it('returns false when signature is missing the ed25519 prefix', () => {
    const { publicKey } = generateEd25519KeyPair();
    const r = { ...recordOf(), signature: 'rsa:abcdef' };
    expect(verifyRecord(r, publicKey)).toBe(false);
  });

  it('returns false when signature has bad base64url', () => {
    const { publicKey } = generateEd25519KeyPair();
    const r = { ...recordOf(), signature: 'ed25519:!!!not_base64url!!!' };
    expect(verifyRecord(r, publicKey)).toBe(false);
  });

  it('PEM round-trip via loadPrivateKey / loadPublicKey', () => {
    const { privateKey, publicKey } = generateEd25519KeyPair();
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
    const reloadedPriv = loadPrivateKey(privPem);
    const reloadedPub = loadPublicKey(pubPem);
    const r = recordOf();
    const sig = signRecord(r, reloadedPriv);
    expect(verifyRecord({ ...r, signature: sig }, reloadedPub)).toBe(true);
  });

  it('loadPrivateKey accepts Buffer input', () => {
    const { privateKey } = generateEd25519KeyPair();
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const privPemBuf = Buffer.from(privPem.toString(), 'utf-8');
    const reloaded = loadPrivateKey(privPemBuf);
    expect(reloaded.type).toBe('private');
  });

  it('loadPublicKey accepts Buffer input', () => {
    const { publicKey } = generateEd25519KeyPair();
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
    const pubPemBuf = Buffer.from(pubPem.toString(), 'utf-8');
    const reloaded = loadPublicKey(pubPemBuf);
    expect(reloaded.type).toBe('public');
  });

  it('returns false when internal verify throws', () => {
    // Pass a non-key object that will cause verify() to throw.
    const r = { ...recordOf(), signature: 'ed25519:AAAA' };
    const badKey = {} as unknown as Parameters<typeof verifyRecord>[1];
    expect(verifyRecord(r, badKey)).toBe(false);
  });
});
