/**
 * createEStopPoller — pull-based safety net. SPEC §5.4.
 *
 * Polls a status endpoint every N seconds; fires `onPress` / `onClear` on
 * transitions. Belt-and-braces alongside push notifications (FlowDot's
 * comms_daemon_commands fan-out).
 */

import type { EStopState } from './types.js';

export interface EStopPollerOptions {
  /** GET endpoint returning an EStopState as JSON. */
  statusUrl: string;
  onPress: (state: EStopState) => void | Promise<void>;
  onClear: (state: EStopState) => void | Promise<void>;
  /** Poll interval. SPEC §5.4 default = 5000. */
  intervalMs?: number;
  /** Headers for auth. */
  headers?: Record<string, string>;
  /** Override fetch for testing. */
  fetch?: typeof fetch;
  /** Callback for poll errors. Default: no-op (logging is host's responsibility). */
  onError?: (err: unknown) => void;
}

const DEFAULT_INTERVAL_MS = 5000;

export class EStopPoller {
  private readonly options: EStopPollerOptions;
  private readonly fetchImpl: typeof fetch;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastPressed: boolean | undefined = undefined;
  private running = false;

  constructor(options: EStopPollerOptions) {
    this.options = options;
    this.fetchImpl = options.fetch ?? fetch;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const interval = this.options.intervalMs ?? DEFAULT_INTERVAL_MS;
    // Kick off immediately so transitions are observed without waiting one tick.
    void this.poll();
    this.timer = setInterval(() => void this.poll(), interval);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Single poll iteration. Exposed for tests. */
  async poll(): Promise<void> {
    try {
      const resp = await this.fetchImpl(this.options.statusUrl, {
        headers: this.options.headers,
      });
      if (!resp.ok) {
        this.options.onError?.(new Error(`status_${resp.status}`));
        return;
      }
      const body = (await resp.json()) as unknown;
      if (!isEStopState(body)) {
        this.options.onError?.(new Error('invalid_state_shape'));
        return;
      }
      const previous = this.lastPressed;
      this.lastPressed = body.pressed;

      if (previous === undefined) {
        // First poll: never fire on the initial observation.
        return;
      }
      if (!previous && body.pressed) {
        await this.options.onPress(body);
      } else if (previous && !body.pressed) {
        await this.options.onClear(body);
      }
    } catch (err) {
      this.options.onError?.(err);
    }
  }
}

export function createEStopPoller(options: EStopPollerOptions): EStopPoller {
  return new EStopPoller(options);
}

function isEStopState(v: unknown): v is EStopState {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  if (typeof obj.pressed !== 'boolean') return false;
  if (obj.pressedAt !== undefined && typeof obj.pressedAt !== 'string') return false;
  if (obj.clearedAt !== undefined && typeof obj.clearedAt !== 'string') return false;
  return true;
}
