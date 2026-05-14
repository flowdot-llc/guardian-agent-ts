/**
 * Gate types. SPEC §4.
 */

import type { ModelAttribution } from '../types.js';

export type GateGranularity = 'tool' | 'toolkit' | 'category';

export type GateDecision = 'allow' | 'allow_session' | 'allow_forever' | 'deny' | 'ban_forever';

export interface GateRequest {
  event_id: string;
  tool_name: string;
  tool_args: Record<string, unknown>;
  agent_id: string;
  session_id: string;
  model?: ModelAttribution;
  context?: string;
  granularity: GateGranularity;
  timeout_ms?: number;
}

export interface GateResponse {
  decision: GateDecision;
  reason?: string;
  operator_id?: string;
  granularity: GateGranularity;
}

export type ApprovalGate = (request: GateRequest) => Promise<GateResponse> | GateResponse;
