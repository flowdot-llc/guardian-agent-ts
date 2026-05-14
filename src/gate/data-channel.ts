/**
 * dataChannelGate — frame encode/decode for LiveKit-style data-channel
 * transports. SPEC §4.3 / §4.4.
 *
 * Wire shape (matches FlowDot's voice/live agent worker contract):
 *   { kind: 'tool_permission_request', requestId, toolName, toolArgs, ... }
 *   { kind: 'tool_permission_response', requestId, decision, granularity, ... }
 *
 * The library does not own the transport; it provides:
 *   - `encodeRequest(GateRequest)` → Uint8Array frame to send on the channel
 *   - `decodeResponse(Uint8Array)` → GateResponse (or null on parse failure)
 *   - `dataChannelGate(send, on)` → ApprovalGate wired to a channel handle
 */

import type { ApprovalGate, GateRequest, GateResponse } from './types.js';

export type DataChannelSend = (frame: Uint8Array) => void | Promise<void>;
export type DataChannelOnResponse = (
  handler: (frame: Uint8Array) => void,
) => () => void;

export interface DataChannelGateOptions {
  send: DataChannelSend;
  /** Subscribe to incoming frames; returns an unsubscribe function. */
  onResponse: DataChannelOnResponse;
  /** Default per-call timeout in ms. SPEC §4.6 default = 600_000. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 600_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

/** Encode a GateRequest to a wire frame (UTF-8 JSON). */
export function encodeRequest(request: GateRequest): Uint8Array {
  return encoder.encode(
    JSON.stringify({
      kind: 'tool_permission_request',
      requestId: request.event_id,
      toolName: request.tool_name,
      toolArgs: request.tool_args,
      agentId: request.agent_id,
      sessionId: request.session_id,
      granularity: request.granularity,
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.context === undefined ? {} : { context: request.context }),
      ...(request.timeout_ms === undefined ? {} : { timeoutMs: request.timeout_ms }),
    }),
  );
}

/**
 * Decode a wire frame. Returns null if the frame is not a valid
 * tool_permission_response for any request.
 */
export function decodeResponse(
  frame: Uint8Array,
): { requestId: string; response: GateResponse } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(frame));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.kind !== 'tool_permission_response') return null;
  if (typeof obj.requestId !== 'string') return null;

  const validDecisions = ['allow', 'allow_session', 'allow_forever', 'deny', 'ban_forever'];
  if (typeof obj.decision !== 'string' || !validDecisions.includes(obj.decision)) {
    return null;
  }
  const validGranularities = ['tool', 'toolkit', 'category'];
  if (typeof obj.granularity !== 'string' || !validGranularities.includes(obj.granularity)) {
    return null;
  }
  if (obj.reason !== undefined && typeof obj.reason !== 'string') return null;
  if (obj.operatorId !== undefined && typeof obj.operatorId !== 'string') return null;

  const response: GateResponse = {
    decision: obj.decision as GateResponse['decision'],
    granularity: obj.granularity as GateResponse['granularity'],
  };
  if (typeof obj.reason === 'string') response.reason = obj.reason;
  if (typeof obj.operatorId === 'string') response.operator_id = obj.operatorId;
  return { requestId: obj.requestId, response };
}

/**
 * Build a data-channel approval gate. The runtime sends a request frame and
 * waits for a matching response frame (matched by `event_id` / `requestId`).
 *
 * On timeout: returns a `deny` response with reason 'gate_timeout' per SPEC §4.6.
 */
export function dataChannelGate(options: DataChannelGateOptions): ApprovalGate {
  const defaultTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pending = new Map<string, (response: GateResponse) => void>();

  const unsubscribe = options.onResponse((frame: Uint8Array) => {
    const decoded = decodeResponse(frame);
    if (!decoded) return;
    const resolver = pending.get(decoded.requestId);
    if (resolver) {
      pending.delete(decoded.requestId);
      resolver(decoded.response);
    }
  });

  const gate: ApprovalGate = async (request) => {
    const timeoutMs = request.timeout_ms ?? defaultTimeout;

    return new Promise<GateResponse>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(request.event_id);
        resolve({
          decision: 'deny',
          reason: 'gate_timeout',
          granularity: request.granularity,
        });
      }, timeoutMs);

      pending.set(request.event_id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });

      // Fire the request frame. Synchronous AND asynchronous failures both
      // surface as deny with reason; wrap via Promise.resolve().then(...)
      // (catches sync throws via the inner function).
      void Promise.resolve()
        .then(() => options.send(encodeRequest(request)))
        .catch((err: unknown) => {
          clearTimeout(timer);
          pending.delete(request.event_id);
          const msg = err instanceof Error ? err.message : String(err);
          resolve({
            decision: 'deny',
            reason: `data_channel_send_error:${msg}`,
            granularity: request.granularity,
          });
        });
    });
  };

  // Expose a dispose method on the gate for callers that want to detach the
  // underlying subscription. Attach as a non-enumerable property.
  Object.defineProperty(gate, 'dispose', {
    value: unsubscribe,
    enumerable: false,
  });

  return gate;
}
