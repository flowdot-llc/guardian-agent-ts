/**
 * EStopLocal — in-process emergency-stop primitive. SPEC §5.3.
 *
 * Single-process deployment: halt flag is an AbortController; clear semantics
 * are terminal (session must be reconstructed).
 */

import type { AuditLogWriter } from '../audit/writer.js';
import type { Notifier } from '../notify/types.js';
import type {
  EStopClearOptions,
  EStopClearResult,
  EStopPressOptions,
  EStopPressResult,
  EStopState,
} from './types.js';

export interface EStopLocalOptions {
  audit?: AuditLogWriter;
  notifier?: Notifier;
  /** If true, construct already-pressed. Useful for tests; rare in production. */
  initiallyPressed?: boolean;
}

export class EStopLocal {
  private state: EStopState;
  private controller: AbortController;
  private readonly audit: AuditLogWriter | undefined;
  private readonly notifier: Notifier | undefined;

  constructor(options: EStopLocalOptions = {}) {
    this.audit = options.audit;
    this.notifier = options.notifier;
    this.controller = new AbortController();
    this.state = { pressed: false };

    if (options.initiallyPressed) {
      this.state = {
        pressed: true,
        pressedAt: new Date().toISOString(),
        pressedReason: 'initially_pressed',
      };
      this.controller.abort();
    }
  }

  /** AbortSignal callers can listen on. Aborts when pressed. */
  get abortSignal(): AbortSignal {
    return this.controller.signal;
  }

  isPressed(): boolean {
    return this.state.pressed;
  }

  getState(): EStopState {
    return { ...this.state };
  }

  async press(options: EStopPressOptions): Promise<EStopPressResult> {
    if (this.state.pressed) {
      // Idempotent: re-pressing doesn't change state but does record an audit event.
      await this.recordEvent('estop_press', options);
      return { state: this.getState() };
    }

    this.state = {
      pressed: true,
      pressedAt: new Date().toISOString(),
      pressedReason: options.reason,
      ...(options.operatorId === undefined ? {} : { pressedOperatorId: options.operatorId }),
    };

    this.controller.abort();
    await this.recordEvent('estop_press', options);
    await this.fireNotification('estop_press', options);

    return { state: this.getState() };
  }

  async clear(options: EStopClearOptions): Promise<EStopClearResult> {
    if (!this.state.pressed) {
      // No-op clear: don't audit, don't notify.
      return { state: this.getState() };
    }

    this.state = {
      pressed: false,
      clearedAt: new Date().toISOString(),
    };

    // EStopLocal does NOT reset the AbortController: the existing signal stays
    // aborted forever. Recovery requires a new EStopLocal instance.

    await this.recordEvent('estop_clear', options);
    await this.fireNotification('estop_clear', options);

    return { state: this.getState() };
  }

  private async recordEvent(
    kind: 'estop_press' | 'estop_clear',
    options: EStopPressOptions | EStopClearOptions,
  ): Promise<void> {
    if (!this.audit) return;
    const detail: Record<string, unknown> = {
      ...(options.detail ?? {}),
    };
    if ('reason' in options) detail.reason = options.reason;
    if (options.operatorId !== undefined) detail.operator_id = options.operatorId;

    await this.audit.append({
      kind,
      status: kind === 'estop_press' ? 'halted' : 'approved',
      initiator: options.initiator ?? 'operator',
      detail,
    });
  }

  private async fireNotification(
    kind: 'estop_press' | 'estop_clear',
    options: EStopPressOptions | EStopClearOptions,
  ): Promise<void> {
    if (!this.notifier) return;
    await this.notifier.notify({
      kind,
      agentId: '',
      ts: new Date().toISOString(),
      source: 'local',
      summary: {
        ...(options.detail ?? {}),
        ...('reason' in options ? { reason: options.reason } : {}),
        ...(options.operatorId !== undefined ? { operator_id: options.operatorId } : {}),
      },
    });
  }
}
