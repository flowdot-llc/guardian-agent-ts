/**
 * Per-capability token-bucket rate limiter. SPEC §5 extension (v0.3.0+).
 *
 * v0.7 of the surface glues used a single global bucket. v0.8 splits the
 * bucket per {@link CapabilityClass}: read-heavy work doesn't get blocked
 * by a writes burst, and an exfil pattern (lots of credential reads +
 * network-egress writes) hits the narrow buckets long before the global
 * rate.
 *
 * A normal-workload session sees zero impact at the conservative defaults
 * documented below. The buckets only bite on bursts that match the exfil
 * shape.
 *
 * Pure mechanism: N token buckets, one per class. Same arithmetic, more
 * dimensions.
 */

import type { CapabilityClass } from './capability.js';

/**
 * Bucket configuration for one capability class.
 */
export interface BucketConfig {
  /** Sustained calls per second. */
  maxCallsPerSecond: number;
  /** Burst capacity. Default = maxCallsPerSecond. */
  bucketCapacity?: number;
}

export interface MultiRateLimiterOptions {
  /**
   * Per-class buckets. Classes not present in this map get the default
   * fallback bucket. Pass `unknown` explicitly if you want untagged tools
   * to share a specific bucket (vs. the default).
   */
  buckets: Partial<Record<CapabilityClass, BucketConfig>>;
  /**
   * Fallback for classes not in `buckets`. When omitted, classes without
   * an explicit config are NOT rate-limited (every call allowed).
   */
  defaultBucket?: BucketConfig;
  /** Time source (testing). */
  now?: () => number;
}

export interface ConsumeAllowed {
  allowed: true;
}

export interface ConsumeDenied {
  allowed: false;
  /** Which class's bucket denied first. */
  class: CapabilityClass;
  /** Estimated ms until the denied bucket has a token again. */
  retryAfterMs: number;
}

export type ConsumeResult = ConsumeAllowed | ConsumeDenied;

/**
 * Library-recommended defaults. Tuned to never trip normal CLI workloads
 * (read/write at human-edit speed, occasional outbound calls) while
 * catching exfil-shaped bursts in the seconds-window.
 */
export const DEFAULT_BUCKETS: Partial<Record<CapabilityClass, BucketConfig>> = {
  read: { maxCallsPerSecond: 50 },
  write: { maxCallsPerSecond: 10 },
  delete: { maxCallsPerSecond: 1 },
  execute: { maxCallsPerSecond: 5 },
  'network-egress': { maxCallsPerSecond: 5 },
  'network-ingress': { maxCallsPerSecond: 50 },
  credential: { maxCallsPerSecond: 2 },
  'system-path': { maxCallsPerSecond: 1 },
  bulk: { maxCallsPerSecond: 2 },
};

class Bucket {
  private readonly refillPerMs: number;
  private readonly capacity: number;
  private readonly now: () => number;
  private tokens: number;
  private lastRefill: number;

  constructor(config: BucketConfig, now: () => number) {
    this.refillPerMs = config.maxCallsPerSecond / 1000;
    this.capacity = config.bucketCapacity ?? config.maxCallsPerSecond;
    this.now = now;
    this.tokens = this.capacity;
    this.lastRefill = this.now();
  }

  tryConsume(): { allowed: true } | { allowed: false; retryAfterMs: number } {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { allowed: true };
    }
    const needed = 1 - this.tokens;
    const retryAfterMs = Math.ceil(needed / this.refillPerMs);
    return { allowed: false, retryAfterMs };
  }

  /** Visible for tests. */
  currentTokens(): number {
    this.refill();
    return this.tokens;
  }

  private refill(): void {
    const t = this.now();
    const elapsed = t - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefill = t;
  }
}

/**
 * Per-capability rate limiter. One {@link Bucket} per class; multi-class
 * tools consume from every relevant bucket atomically (first denial wins;
 * earlier-class buckets already consumed are NOT refunded).
 *
 * "First denial wins, no refund" matches the safety-conservative
 * interpretation: a multi-class tool that's blocked on its rarest
 * capability is fully blocked. The slightly-tighter accounting on
 * already-consumed buckets is acceptable because it errs on the side of
 * slowing the caller (not letting more through).
 */
export class MultiRateLimiter {
  private readonly buckets = new Map<CapabilityClass, Bucket>();
  private readonly defaultBucket: Bucket | undefined;
  private readonly now: () => number;
  private readonly configMap: Map<CapabilityClass, BucketConfig>;
  private readonly defaultConfig: BucketConfig | undefined;

  constructor(options: MultiRateLimiterOptions) {
    this.now = options.now ?? Date.now;
    this.configMap = new Map(Object.entries(options.buckets) as [CapabilityClass, BucketConfig][]);
    this.defaultConfig = options.defaultBucket;
    if (this.defaultConfig !== undefined) {
      this.defaultBucket = new Bucket(this.defaultConfig, this.now);
    }
    for (const [cls, cfg] of this.configMap.entries()) {
      this.buckets.set(cls, new Bucket(cfg, this.now));
    }
  }

  /**
   * Attempt to consume one token from every relevant bucket. If ANY bucket
   * is empty, return the FIRST class to deny (in iteration order of
   * `classes`). Tokens already consumed from earlier classes in this call
   * are not refunded — see class JSDoc.
   *
   * `unknown` (or any class not in `buckets` and no `defaultBucket`)
   * passes through allowed.
   */
  tryConsume(classes: readonly CapabilityClass[]): ConsumeResult {
    for (const cls of classes) {
      let bucket = this.buckets.get(cls);
      if (!bucket && this.defaultBucket) {
        bucket = this.defaultBucket;
      }
      if (!bucket) continue; // no policy for this class → allowed
      const r = bucket.tryConsume();
      if (!r.allowed) {
        return { allowed: false, class: cls, retryAfterMs: r.retryAfterMs };
      }
    }
    return { allowed: true };
  }

  /** Current token count per class (tests + introspection). */
  snapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [cls, bucket] of this.buckets.entries()) {
      out[cls] = bucket.currentTokens();
    }
    if (this.defaultBucket) out['_default'] = this.defaultBucket.currentTokens();
    return out;
  }
}
