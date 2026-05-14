import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BUCKETS,
  MultiRateLimiter,
} from '../../src/runtime/multi-rate-limiter.js';

describe('MultiRateLimiter', () => {
  it('per-class bucket: read at 50/s allows 50 in a burst', () => {
    let now = 0;
    const rl = new MultiRateLimiter({
      buckets: { read: { maxCallsPerSecond: 50 } },
      now: () => now,
    });
    for (let i = 0; i < 50; i++) {
      expect(rl.tryConsume(['read']).allowed).toBe(true);
    }
    const r = rl.tryConsume(['read']);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.class).toBe('read');
      expect(r.retryAfterMs).toBeGreaterThan(0);
    }
  });

  it('credential bucket at 2/s denies the 3rd in a burst', () => {
    let now = 0;
    const rl = new MultiRateLimiter({
      buckets: { credential: { maxCallsPerSecond: 2 } },
      now: () => now,
    });
    expect(rl.tryConsume(['credential']).allowed).toBe(true);
    expect(rl.tryConsume(['credential']).allowed).toBe(true);
    const r = rl.tryConsume(['credential']);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.class).toBe('credential');
  });

  it('buckets are independent per class', () => {
    let now = 0;
    const rl = new MultiRateLimiter({
      buckets: {
        credential: { maxCallsPerSecond: 1 },
        read: { maxCallsPerSecond: 50 },
      },
      now: () => now,
    });
    expect(rl.tryConsume(['credential']).allowed).toBe(true);
    // credential is exhausted, but read should still work.
    for (let i = 0; i < 50; i++) {
      expect(rl.tryConsume(['read']).allowed).toBe(true);
    }
    expect(rl.tryConsume(['credential']).allowed).toBe(false);
  });

  it('multi-class tool fails at the FIRST class to deny (iteration order)', () => {
    let now = 0;
    const rl = new MultiRateLimiter({
      buckets: {
        credential: { maxCallsPerSecond: 1 },
        write: { maxCallsPerSecond: 100 },
      },
      now: () => now,
    });
    expect(rl.tryConsume(['write', 'credential']).allowed).toBe(true);
    const r = rl.tryConsume(['write', 'credential']);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.class).toBe('credential');
  });

  it('class with no bucket and no default passes through', () => {
    let now = 0;
    const rl = new MultiRateLimiter({ buckets: { read: { maxCallsPerSecond: 1 } }, now: () => now });
    // 'unknown' is not configured and no defaultBucket → unlimited
    for (let i = 0; i < 100; i++) {
      expect(rl.tryConsume(['unknown']).allowed).toBe(true);
    }
  });

  it('default bucket catches classes without explicit config', () => {
    let now = 0;
    const rl = new MultiRateLimiter({
      buckets: {},
      defaultBucket: { maxCallsPerSecond: 2 },
      now: () => now,
    });
    expect(rl.tryConsume(['unknown']).allowed).toBe(true);
    expect(rl.tryConsume(['unknown']).allowed).toBe(true);
    expect(rl.tryConsume(['unknown']).allowed).toBe(false);
  });

  it('refills over time', () => {
    let now = 0;
    const rl = new MultiRateLimiter({
      buckets: { read: { maxCallsPerSecond: 10 } },
      now: () => now,
    });
    for (let i = 0; i < 10; i++) rl.tryConsume(['read']);
    expect(rl.tryConsume(['read']).allowed).toBe(false);
    now = 100; // +100ms → +1 token at 10/s
    expect(rl.tryConsume(['read']).allowed).toBe(true);
  });

  it('honors custom bucketCapacity', () => {
    let now = 0;
    const rl = new MultiRateLimiter({
      buckets: { credential: { maxCallsPerSecond: 1, bucketCapacity: 5 } },
      now: () => now,
    });
    for (let i = 0; i < 5; i++) {
      expect(rl.tryConsume(['credential']).allowed).toBe(true);
    }
    expect(rl.tryConsume(['credential']).allowed).toBe(false);
  });

  it('snapshot reports per-class current tokens', () => {
    let now = 0;
    const rl = new MultiRateLimiter({
      buckets: { read: { maxCallsPerSecond: 50 } },
      defaultBucket: { maxCallsPerSecond: 3 },
      now: () => now,
    });
    rl.tryConsume(['read']);
    rl.tryConsume(['unknown']);
    const s = rl.snapshot();
    expect(s.read).toBeLessThan(50);
    expect(s._default).toBeLessThan(3);
  });

  it('uses Date.now when no now provided', () => {
    const rl = new MultiRateLimiter({ buckets: { read: { maxCallsPerSecond: 1 } } });
    expect(rl.tryConsume(['read']).allowed).toBe(true);
  });

  it('first-denial-no-refund: earlier-class buckets consumed even on later denial', () => {
    let now = 0;
    const rl = new MultiRateLimiter({
      buckets: {
        write: { maxCallsPerSecond: 10 },
        credential: { maxCallsPerSecond: 1, bucketCapacity: 1 },
      },
      now: () => now,
    });
    // Drain credential first
    expect(rl.tryConsume(['credential']).allowed).toBe(true);
    const before = rl.snapshot().write;
    // Multi-class call: write would pass but credential fails
    const r = rl.tryConsume(['write', 'credential']);
    expect(r.allowed).toBe(false);
    const after = rl.snapshot().write;
    // write WAS consumed before the credential check denied. Documented
    // behavior: first-denial-no-refund.
    expect((after as number)).toBeLessThan(before as number);
  });

  it('DEFAULT_BUCKETS are conservative — credential capped at 2/s', () => {
    expect(DEFAULT_BUCKETS.credential).toEqual({ maxCallsPerSecond: 2 });
    expect(DEFAULT_BUCKETS.delete).toEqual({ maxCallsPerSecond: 1 });
    expect(DEFAULT_BUCKETS.read).toEqual({ maxCallsPerSecond: 50 });
  });
});
