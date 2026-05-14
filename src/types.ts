/**
 * Shared types matching SPEC §2. The wire format the audit log uses on disk.
 */

export const SPEC_VERSION = '0.2.0' as const;

export type AuditRecordKind =
  | 'session_open'
  | 'tool_call'
  | 'gate_request'
  | 'gate_response'
  | 'policy_check'
  | 'tool_result'
  | 'estop_press'
  | 'estop_clear'
  | 'session_close';

export type AuditRecordStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'executed'
  | 'errored'
  | 'halted';

export type AuditRecordInitiator = 'operator' | 'agent' | 'system';

/**
 * Identifies which model issued a tool call. SPEC §2.3.
 *
 * The optional `surface` and `aggregator` fields (v0.7+) extend the basic
 * `provider/id` pair with the chain that delivered the call:
 *
 *   surface       — which FlowDot surface (or third-party harness) is hosting
 *                   the agent (e.g., 'FlowDot', 'FlowDotMobile', 'cursor').
 *   aggregator    — the optional intermediary that routed the request
 *                   (e.g., 'RedPill', 'OpenRouter'). `'direct'` is the
 *                   convention when no aggregator is in the path.
 *   provider      — the model vendor (e.g., 'Anthropic', 'OpenAI').
 *   id            — the specific model id (e.g., 'claude-opus-4.5').
 *
 * Rendered as `surface/aggregator/provider/id` (see
 * `policy/attribution.ts:renderAttributionPath`) for glob-based policy rules.
 *
 * Missing segments render as `'*'`. Old call sites that only supply
 * `{provider, id}` continue to work and render as `*\/*\/<provider>/<id>`.
 */
export interface ModelAttribution {
  provider: string;
  id: string;
  surface?: string;
  aggregator?: string;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Tool sub-object on relevant event kinds. SPEC §2.3.
 */
export interface AuditRecordTool {
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  durationMs?: number;
}

/**
 * The audit record itself. Every line in the JSONL log is one of these.
 * Field names match the wire spec (snake_case) for cross-language interop.
 */
export interface AuditRecord {
  v: string;
  event_id: string;
  ts: string;
  agent_id: string;
  session_id: string;
  kind: AuditRecordKind;
  tool?: {
    name: string;
    args: Record<string, unknown>;
    result?: unknown;
    duration_ms?: number;
  };
  model?: {
    provider: string;
    id: string;
    surface?: string;
    aggregator?: string;
    input_tokens?: number;
    output_tokens?: number;
  };
  status: AuditRecordStatus;
  initiator: AuditRecordInitiator;
  prev_hash: string;
  signature?: string | null;
  /** Optional free-form structured details (e.g., gate decision, estop reason). */
  detail?: Record<string, unknown>;
}

/**
 * The fields a caller supplies. The writer fills in the rest.
 */
export type AuditRecordInput = Omit<
  AuditRecord,
  'v' | 'event_id' | 'ts' | 'agent_id' | 'session_id' | 'prev_hash' | 'signature'
> & {
  agentId?: string;
  sessionId?: string;
};
