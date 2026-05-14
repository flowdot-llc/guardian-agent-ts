/**
 * EStop types. SPEC §5.
 */

import type { AuditRecordInitiator } from '../types.js';

export interface EStopPressOptions {
  reason: string;
  operatorId?: string;
  initiator?: AuditRecordInitiator;
  /** Free-form structured details (IP, user-agent, etc.) recorded on the audit row. */
  detail?: Record<string, unknown>;
}

export interface EStopClearOptions {
  operatorId?: string;
  initiator?: AuditRecordInitiator;
  detail?: Record<string, unknown>;
}

export interface EStopState {
  pressed: boolean;
  pressedAt?: string;
  pressedReason?: string;
  pressedOperatorId?: string;
  clearedAt?: string;
}

export interface EStopPressResult {
  state: EStopState;
}

export interface EStopClearResult {
  state: EStopState;
  authRequired?: boolean;
}
