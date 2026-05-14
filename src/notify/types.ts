/**
 * Notification types. SPEC §6.
 */

export type NotificationKind =
  | 'estop_press'
  | 'estop_clear'
  | 'policy_breach'
  | 'gate_denied';

export interface NotificationEvent {
  kind: NotificationKind;
  /** User identifier on hub-coordinated deployments; undefined in single-process. */
  userId?: string;
  agentId: string;
  ts: string;
  /** "cli" | "native" | "mobile" | "hub" | "local" | host-defined */
  source: string;
  /** Free-form structured summary (counts, IP, reason, …). */
  summary: Record<string, unknown>;
  /** Optional canonical clear URL for hub-coordinated deployments. */
  canonicalClearUrl?: string;
}

export interface Notifier {
  notify(event: NotificationEvent): Promise<void>;
}
