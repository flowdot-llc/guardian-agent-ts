/**
 * EStopHub — hub-coordinated emergency-stop adapter. SPEC §5.4.
 *
 * Pluggable state store (in-memory by default; FlowDot supplies a SQL adapter).
 * Per-user scoping. 1-second cache TTL on isPressed reads (matches FlowDot).
 * Notifier fan-out on every press AND clear.
 */

import type { AuditLogWriter } from '../audit/writer.js';
import type { Notifier, NotificationKind } from '../notify/types.js';
import type {
  EStopClearOptions,
  EStopClearResult,
  EStopPressOptions,
  EStopPressResult,
  EStopState,
} from './types.js';

/**
 * Backing store for hub state. Implementations: in-memory (default),
 * SQL-backed (host-supplied).
 */
export interface EStopStateStore {
  get(userId: string): Promise<EStopState | null>;
  set(userId: string, state: EStopState): Promise<void>;
}

/**
 * Channel that fans out press notifications to live daemons (push side).
 * Library-internal; FlowDot supplies the `comms_daemon_commands` adapter.
 */
export interface EStopBroadcastChannel {
  broadcastPress(userId: string, state: EStopState): Promise<void>;
  broadcastClear(userId: string, state: EStopState): Promise<void>;
}

export interface EStopHubOptions {
  state: EStopStateStore;
  audit: AuditLogWriter;
  notifier?: Notifier;
  broadcast?: EStopBroadcastChannel;
  /** Cache TTL for isPressed in ms. SPEC §5.4 default = 1000. */
  cacheTtlMs?: number;
  /**
   * Required recent-auth check for clear() — host supplies it. Return true if
   * the operator has confirmed authentication recently; false to force a
   * second factor (password.confirm flow on the host).
   */
  recentAuthCheck?: (userId: string, options: EStopClearOptions) => Promise<boolean>;
  /** Canonical clear URL included in notifications. */
  canonicalClearUrl?: string;
}

/** Source surface tag included in audit + notification. */
export interface EStopActorContext {
  source: string;
  ip?: string;
  userAgent?: string;
}

const DEFAULT_CACHE_TTL_MS = 1000;

export class EStopHub {
  private readonly state: EStopStateStore;
  private readonly audit: AuditLogWriter;
  private readonly notifier: Notifier | undefined;
  private readonly broadcast: EStopBroadcastChannel | undefined;
  private readonly cacheTtlMs: number;
  private readonly recentAuthCheck:
    | ((userId: string, options: EStopClearOptions) => Promise<boolean>)
    | undefined;
  private readonly canonicalClearUrl: string | undefined;

  private cache = new Map<string, { value: boolean; expiresAt: number }>();

  constructor(options: EStopHubOptions) {
    this.state = options.state;
    this.audit = options.audit;
    this.notifier = options.notifier;
    this.broadcast = options.broadcast;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.recentAuthCheck = options.recentAuthCheck;
    this.canonicalClearUrl = options.canonicalClearUrl;
  }

  /** Cached, hot-path check used by the middleware. */
  async isPressed(userId: string): Promise<boolean> {
    const now = Date.now();
    const entry = this.cache.get(userId);
    if (entry && entry.expiresAt > now) return entry.value;

    const state = await this.state.get(userId);
    const pressed = state?.pressed ?? false;
    this.cache.set(userId, { value: pressed, expiresAt: now + this.cacheTtlMs });
    return pressed;
  }

  async status(userId: string): Promise<EStopState> {
    return (await this.state.get(userId)) ?? { pressed: false };
  }

  async press(
    userId: string,
    options: EStopPressOptions,
    actor: EStopActorContext = { source: 'hub' },
  ): Promise<EStopPressResult> {
    // SPEC §7: reject agent-initiated press only if deployment policy demands
    // it. The library default allows agent-initiated press (they SHOULD be
    // able to halt themselves on anomaly). The caller controls via initiator.
    const initiator = options.initiator ?? 'operator';

    const existing = (await this.state.get(userId)) ?? { pressed: false };
    const newState: EStopState = existing.pressed
      ? existing
      : {
          pressed: true,
          pressedAt: new Date().toISOString(),
          pressedReason: options.reason,
          ...(options.operatorId === undefined ? {} : { pressedOperatorId: options.operatorId }),
        };

    if (!existing.pressed) {
      await this.state.set(userId, newState);
      this.invalidateCache(userId);
    }

    await this.audit.append({
      kind: 'estop_press',
      status: 'halted',
      initiator,
      detail: {
        user_id: userId,
        source: actor.source,
        reason: options.reason,
        ...(options.operatorId === undefined ? {} : { operator_id: options.operatorId }),
        ...(actor.ip === undefined ? {} : { ip: actor.ip }),
        ...(actor.userAgent === undefined ? {} : { user_agent: actor.userAgent }),
        ...(options.detail ?? {}),
      },
    });

    if (this.broadcast && !existing.pressed) {
      await this.broadcast.broadcastPress(userId, newState);
    }

    await this.fireNotification('estop_press', userId, actor, {
      reason: options.reason,
      ...(options.operatorId === undefined ? {} : { operator_id: options.operatorId }),
      ...(options.detail ?? {}),
    });

    return { state: { ...newState } };
  }

  async clear(
    userId: string,
    options: EStopClearOptions,
    actor: EStopActorContext = { source: 'hub' },
  ): Promise<EStopClearResult> {
    // SPEC §7: agent-initiated clear MUST be rejected.
    const initiator = options.initiator ?? 'operator';
    if (initiator === 'agent') {
      return {
        state: (await this.state.get(userId)) ?? { pressed: false },
        authRequired: false,
      };
    }

    if (this.recentAuthCheck) {
      const ok = await this.recentAuthCheck(userId, options);
      if (!ok) {
        return {
          state: (await this.state.get(userId)) ?? { pressed: false },
          authRequired: true,
        };
      }
    }

    const existing = (await this.state.get(userId)) ?? { pressed: false };
    if (!existing.pressed) {
      return { state: existing };
    }

    const cleared: EStopState = {
      pressed: false,
      clearedAt: new Date().toISOString(),
    };
    await this.state.set(userId, cleared);
    this.invalidateCache(userId);

    await this.audit.append({
      kind: 'estop_clear',
      status: 'approved',
      initiator,
      detail: {
        user_id: userId,
        source: actor.source,
        ...(options.operatorId === undefined ? {} : { operator_id: options.operatorId }),
        ...(actor.ip === undefined ? {} : { ip: actor.ip }),
        ...(actor.userAgent === undefined ? {} : { user_agent: actor.userAgent }),
        ...(options.detail ?? {}),
      },
    });

    if (this.broadcast) {
      await this.broadcast.broadcastClear(userId, cleared);
    }

    await this.fireNotification('estop_clear', userId, actor, {
      ...(options.operatorId === undefined ? {} : { operator_id: options.operatorId }),
      ...(options.detail ?? {}),
    });

    return { state: cleared };
  }

  /** Force-invalidate a single user's cache entry. Idempotent. */
  invalidateCache(userId: string): void {
    this.cache.delete(userId);
  }

  /** Clear the entire cache. Useful for tests + Redis-down scenarios. */
  invalidateAllCache(): void {
    this.cache.clear();
  }

  private async fireNotification(
    kind: NotificationKind,
    userId: string,
    actor: EStopActorContext,
    summary: Record<string, unknown>,
  ): Promise<void> {
    if (!this.notifier) return;
    await this.notifier.notify({
      kind,
      userId,
      agentId: '',
      ts: new Date().toISOString(),
      source: actor.source,
      summary,
      ...(this.canonicalClearUrl === undefined
        ? {}
        : { canonicalClearUrl: this.canonicalClearUrl }),
    });
  }
}

/** Reference in-memory state store. */
export class InMemoryEStopStateStore implements EStopStateStore {
  private states = new Map<string, EStopState>();

  async get(userId: string): Promise<EStopState | null> {
    return this.states.get(userId) ?? null;
  }

  async set(userId: string, state: EStopState): Promise<void> {
    this.states.set(userId, state);
  }
}
