/**
 * Capability tags + sliding-window combination detection. SPEC §4 extension
 * (v0.3.0+).
 *
 * Each tool is tagged with one or more capability classes (the canonical
 * set is documented below but consumers can register additional strings).
 * The supervisor maintains a per-session sliding window of recent tool
 * calls + their capability sets. Rules describe "suspicious combinations"
 * — a list of classes that, if all observed within `window_ms`, fire an
 * event.
 *
 * v0.8 ships YELLOW-LINE ONLY. A combination match writes
 * `x_capability_yellow` to the audit log; dispatch is NOT blocked. The
 * point is to collect calibration data. Red-line auto-stop ships in v0.10
 * after the v0.8 corpus shows zero false positives at proposed thresholds.
 *
 * Pure mechanism: tag lookup + set membership over a fixed-window event
 * list. Constant memory per session (oldest events drop as window slides).
 */

/**
 * Canonical capability classes. The string-union form lets consumers extend
 * with their own strings (e.g., `'database-write'` for a SQL-tool surface)
 * without forking the library.
 *
 * Class meanings (canonical):
 * - `read`            — pure read of agent-accessible data
 * - `write`           — local write of agent-accessible data
 * - `delete`          — destruction of agent-accessible data
 * - `execute`         — run a subprocess / arbitrary code
 * - `network-egress`  — outbound network call
 * - `network-ingress` — accept inbound network call
 * - `credential`      — read or write credentials
 * - `system-path`     — touch OS-level paths (`/etc`, `~/.ssh`, etc.)
 * - `bulk`            — operation over many items (>N, configurable per-tool)
 * - `unknown`         — fallback for untagged tools
 */
export type CapabilityClass =
  | 'read'
  | 'write'
  | 'delete'
  | 'execute'
  | 'network-egress'
  | 'network-ingress'
  | 'credential'
  | 'system-path'
  | 'bulk'
  | 'unknown'
  | (string & {}); // allow consumer-defined classes (TS string-literal-union escape)

/**
 * One rule in the capability-rule set. A rule matches when every class in
 * `combination` has been observed within the last `window_ms`.
 *
 * `level` is `'yellow'` in v0.8 (audit-only). `'red'` (auto-E-stop) lands
 * in v0.10 once Yellow data justifies thresholds.
 */
export interface CapabilityRule {
  /** Stable id used in audit records. ASCII, short. */
  id: string;
  /** Free-form human note. Ignored by the matcher. */
  description?: string;
  /** Classes that must all appear within the window. Order is irrelevant. */
  combination: CapabilityClass[];
  /** Time window in milliseconds. */
  window_ms: number;
  /** v0.8: always 'yellow'. v0.10 adds 'red'. */
  level: 'yellow' | 'red';
}

/**
 * Event recorded into the sliding window. The supervisor synthesizes these
 * after every dispatched tool call; they hold only what the matcher needs.
 */
export interface CapabilityEvent {
  /** Wall-clock ms (monotonic preferred when consumer supplies a `now`). */
  ts: number;
  /** Capability classes of THIS specific tool call. */
  classes: CapabilityClass[];
  /** Audit event_id, copied so a fired rule can cite the contributing events. */
  eventId: string;
}

/**
 * Result of recording one event. Lists every rule that fired on this event.
 * Most events fire nothing; this array is typically empty.
 */
export interface CapabilityMatch {
  ruleId: string;
  level: 'yellow' | 'red';
  combination: CapabilityClass[];
  window_ms: number;
  /** event_ids of the events that contributed to the match, in chronological order. */
  contributingEventIds: string[];
}

export interface CapabilityWindowOptions {
  rules: CapabilityRule[];
  /** Override for time source (testing). Defaults to Date.now. */
  now?: () => number;
  /**
   * Maximum events kept in the window irrespective of age. Defensive cap so
   * a runaway agent can't grow the buffer without bound. Default 10000.
   */
  maxEvents?: number;
}

/**
 * Per-session sliding-window state. One instance per supervisor.
 *
 * Memory: O(max window_ms × call rate) in the worst case, capped at
 * `maxEvents`. Events older than the longest rule window are dropped on
 * every `record` call.
 */
export class CapabilityWindow {
  private readonly rules: CapabilityRule[];
  private readonly now: () => number;
  private readonly maxEvents: number;
  private readonly maxWindowMs: number;
  private events: CapabilityEvent[] = [];

  constructor(options: CapabilityWindowOptions) {
    this.rules = options.rules;
    this.now = options.now ?? Date.now;
    this.maxEvents = options.maxEvents ?? 10_000;
    this.maxWindowMs = this.rules.reduce(
      (m, r) => Math.max(m, r.window_ms),
      0,
    );
    // Validate rule shapes once.
    for (const r of this.rules) {
      if (r.combination.length === 0) {
        throw new Error(`CapabilityRule ${JSON.stringify(r.id)} has empty combination`);
      }
      if (r.window_ms <= 0) {
        throw new Error(`CapabilityRule ${JSON.stringify(r.id)} has non-positive window_ms`);
      }
    }
  }

  /**
   * Record a tool dispatch + evaluate all rules against the current window.
   *
   * Returns the list of rules that fired (often empty). Caller is
   * responsible for converting fires into audit rows + (in v0.10) E-stop
   * presses.
   */
  record(classes: CapabilityClass[], eventId: string): CapabilityMatch[] {
    const ts = this.now();
    const event: CapabilityEvent = { ts, classes, eventId };
    this.events.push(event);

    // Age-based prune.
    if (this.maxWindowMs > 0) {
      const cutoff = ts - this.maxWindowMs;
      while (this.events.length > 0 && (this.events[0] as CapabilityEvent).ts < cutoff) {
        this.events.shift();
      }
    }
    // Hard cap.
    while (this.events.length > this.maxEvents) {
      this.events.shift();
    }

    // Evaluate each rule against the current window.
    const matches: CapabilityMatch[] = [];
    for (const rule of this.rules) {
      const m = this.evaluateRule(rule, ts);
      if (m) matches.push(m);
    }
    return matches;
  }

  /** Snapshot of currently-buffered events (for tests + introspection). */
  buffered(): readonly CapabilityEvent[] {
    return this.events;
  }

  /**
   * Test whether `rule` is satisfied by the current window ending at `now`.
   * Returns the contributing event ids on match, null otherwise.
   *
   * Algorithm: for each class in `combination`, find the most-recent event
   * (within the window) that includes that class. If every class found a
   * contributor, the rule matches.
   */
  private evaluateRule(rule: CapabilityRule, now: number): CapabilityMatch | null {
    const cutoff = now - rule.window_ms;
    const required = new Set<CapabilityClass>(rule.combination);
    const contributors = new Map<CapabilityClass, CapabilityEvent>();
    for (let i = this.events.length - 1; i >= 0; i--) {
      const ev = this.events[i] as CapabilityEvent;
      if (ev.ts < cutoff) break;
      for (const cls of ev.classes) {
        if (required.has(cls) && !contributors.has(cls)) {
          contributors.set(cls, ev);
        }
      }
      if (contributors.size === required.size) break;
    }
    if (contributors.size < required.size) return null;
    // Order contributing events chronologically + dedupe (a single
    // multi-class event may satisfy several required classes).
    const ids = Array.from(new Set(Array.from(contributors.values()).sort((a, b) => a.ts - b.ts).map((e) => e.eventId)));
    return {
      ruleId: rule.id,
      level: rule.level,
      combination: rule.combination,
      window_ms: rule.window_ms,
      contributingEventIds: ids,
    };
  }
}
