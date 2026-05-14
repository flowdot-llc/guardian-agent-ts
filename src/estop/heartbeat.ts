/**
 * Dead-man's-switch heartbeat. SPEC §6 (v0.4.0+).
 *
 * For long-running surfaces (CLI daemon, MCP server's persistent session,
 * Native main loop) the agent (or its harness) must call
 * `monitor.heartbeat()` every N seconds. If no heartbeat arrives within
 * `softMs`, an `x_heartbeat_warning` audit row is written (no behavior
 * change). If still no heartbeat by `hardMs`, the configured `EStopLocal`
 * is pressed with `reason: 'heartbeat_missed'`.
 *
 * Pure mechanism: setInterval + timestamp arithmetic. The supervisor does
 * not decide whether the agent should be alive — only whether it is
 * claiming to be.
 *
 * OPT-IN PER SURFACE. Default OFF. A surface that hasn't wired
 * `heartbeat()` calls into its main loop must not enable this — that's a
 * day-1 false E-stop.
 */

import type { AuditLogWriter } from '../audit/writer.js';
import type { EStopLocal } from './local.js';

export interface HeartbeatMonitorOptions {
  /** Audit log writer for `x_heartbeat_warning` rows. Optional. */
  audit?: AuditLogWriter;
  /**
   * EStopLocal to press on hard miss. When omitted, hard-miss behavior is
   * audit-only (mostly useful for testing the monitor itself).
   */
  estop?: EStopLocal;
  /**
   * Soft window in ms. After this many ms with no heartbeat, write
   * `x_heartbeat_warning`. Must be < hardMs.
   */
  softMs: number;
  /**
   * Hard window in ms. After this many ms with no heartbeat, press the
   * EStop with `reason: 'heartbeat_missed'`.
   */
  hardMs: number;
  /**
   * How often to check (ms). Default = min(softMs, hardMs) / 4, clamped
   * to [50, 5000]. Smaller = tighter response; larger = lower CPU cost.
   */
  checkIntervalMs?: number;
  /** Time source override (testing). */
  now?: () => number;
  /**
   * setInterval override (testing). Must return a token that
   * `clearIntervalFn` accepts.
   */
  setIntervalFn?: (cb: () => void, ms: number) => unknown;
  /** clearInterval override (testing). */
  clearIntervalFn?: (handle: unknown) => void;
}

/**
 * State machine: idle → softMissed → hardMissed. Each transition writes
 * an audit row (warning for softMissed, estop_press for hardMissed). The
 * monitor stops checking once hardMissed fires; restart by constructing a
 * new monitor (a new session).
 */
export class HeartbeatMonitor {
  private readonly audit: AuditLogWriter | undefined;
  private readonly estop: EStopLocal | undefined;
  private readonly softMs: number;
  private readonly hardMs: number;
  private readonly checkIntervalMs: number;
  private readonly now: () => number;
  private readonly setIntervalFn: (cb: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;

  private lastBeat: number;
  private state: 'idle' | 'softMissed' | 'hardMissed' = 'idle';
  private interval: unknown = null;
  private stopped = false;

  constructor(options: HeartbeatMonitorOptions) {
    if (options.softMs <= 0) throw new Error('softMs must be > 0');
    if (options.hardMs <= options.softMs) {
      throw new Error('hardMs must be > softMs');
    }
    this.audit = options.audit;
    this.estop = options.estop;
    this.softMs = options.softMs;
    this.hardMs = options.hardMs;
    this.now = options.now ?? Date.now;
    this.setIntervalFn =
      options.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms) as unknown);
    this.clearIntervalFn =
      options.clearIntervalFn ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
    this.checkIntervalMs =
      options.checkIntervalMs ?? Math.max(50, Math.min(5000, Math.floor(this.softMs / 4)));
    this.lastBeat = this.now();
  }

  /** Start the watchdog. Idempotent. */
  start(): void {
    if (this.interval !== null || this.stopped) return;
    this.lastBeat = this.now();
    this.interval = this.setIntervalFn(() => {
      void this.tick();
    }, this.checkIntervalMs);
  }

  /** Stop the watchdog. Idempotent. Call from supervisor close(). */
  stop(): void {
    this.stopped = true;
    if (this.interval !== null) {
      this.clearIntervalFn(this.interval);
      this.interval = null;
    }
  }

  /**
   * Record a heartbeat. Resets the state machine to `idle` if a soft
   * warning had fired but no hard miss yet.
   */
  heartbeat(): void {
    if (this.state === 'hardMissed') {
      // Cannot recover from a hard miss. Caller should restart the session.
      return;
    }
    this.lastBeat = this.now();
    this.state = 'idle';
  }

  /** Current state (for tests + introspection). */
  getState(): { state: 'idle' | 'softMissed' | 'hardMissed'; lastBeatMs: number } {
    return { state: this.state, lastBeatMs: this.lastBeat };
  }

  /**
   * Public tick. Called automatically by the interval; exposed so tests can
   * drive deterministically without real timers.
   */
  async tick(): Promise<void> {
    if (this.stopped) return;
    const elapsed = this.now() - this.lastBeat;
    if (elapsed >= this.hardMs && this.state !== 'hardMissed') {
      this.state = 'hardMissed';
      if (this.audit) {
        // Audit the miss explicitly even though estop.press will also write
        // an estop_press row. The two are useful together: the warning
        // captures the elapsed time + threshold, the estop_press carries
        // the eventual halt.
        await this.audit.append({
          kind: 'x_heartbeat_warning' as unknown as 'policy_check',
          status: 'halted',
          initiator: 'system',
          detail: { elapsed_ms: elapsed, hard_ms: this.hardMs, level: 'hard' },
        });
      }
      if (this.estop) {
        await this.estop.press({
          reason: 'heartbeat_missed',
          initiator: 'system',
        });
      }
      // Once hard-missed, stop checking — the session is halted.
      this.stop();
      return;
    }
    if (elapsed >= this.softMs && this.state === 'idle') {
      this.state = 'softMissed';
      if (this.audit) {
        await this.audit.append({
          kind: 'x_heartbeat_warning' as unknown as 'policy_check',
          status: 'approved',
          initiator: 'system',
          detail: { elapsed_ms: elapsed, soft_ms: this.softMs, level: 'soft' },
        });
      }
    }
  }
}
