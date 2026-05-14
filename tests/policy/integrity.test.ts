import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { signPayload, verifyPayload } from '../../src/policy/integrity.js';

describe('signPayload / verifyPayload', () => {
  it('round-trips a string payload', () => {
    const key = randomBytes(32);
    const sig = signPayload('hello world', key);
    expect(verifyPayload('hello world', sig, key)).toBe(true);
  });

  it('round-trips a buffer payload', () => {
    const key = randomBytes(32);
    const data = Buffer.from('hello buffer', 'utf-8');
    const sig = signPayload(data, key);
    expect(verifyPayload(data, sig, key)).toBe(true);
  });

  it('rejects with wrong key', () => {
    const key = randomBytes(32);
    const other = randomBytes(32);
    const sig = signPayload('hi', key);
    expect(verifyPayload('hi', sig, other)).toBe(false);
  });

  it('rejects with tampered data', () => {
    const key = randomBytes(32);
    const sig = signPayload('hi', key);
    expect(verifyPayload('ho', sig, key)).toBe(false);
  });

  it('rejects malformed signature gracefully', () => {
    const key = randomBytes(32);
    // The wrong-length-but-valid-base64 path.
    expect(verifyPayload('hi', 'AA==', key)).toBe(false);
  });

  it('produces a base64 string', () => {
    const sig = signPayload('hi', randomBytes(32));
    expect(sig).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });
});
