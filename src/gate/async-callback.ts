/**
 * asyncCallbackGate — POSTs the GateRequest to a callback URL, awaits a JSON
 * GateResponse. SPEC §4.3.
 */

import type { ApprovalGate, GateRequest, GateResponse } from './types.js';

export interface AsyncCallbackGateOptions {
  /** Endpoint URL to POST GateRequest payloads at. */
  url: string;
  /** Default timeout in ms. May be overridden per-request via `timeout_ms`. */
  timeoutMs?: number;
  /** Additional headers (e.g., Authorization). */
  headers?: Record<string, string>;
  /** Override fetch (for testing). */
  fetch?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes (matches SPEC §4.6 default)

/**
 * Build an async-callback gate. The returned function POSTs the
 * GateRequest as JSON and parses the response.
 *
 * Failure modes — all yield `decision: 'deny'` with reason in the response:
 *   - Network error or non-2xx HTTP status
 *   - Timeout (per-request or default)
 *   - JSON parse failure
 *   - Response shape doesn't match GateResponse
 */
export function asyncCallbackGate(options: AsyncCallbackGateOptions): ApprovalGate {
  const fetchImpl = options.fetch ?? fetch;
  const defaultTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseHeaders = options.headers ?? {};

  return async (request: GateRequest): Promise<GateResponse> => {
    const timeoutMs = request.timeout_ms ?? defaultTimeout;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const result = await runRequest(fetchImpl, options.url, request, controller, baseHeaders);
    clearTimeout(timer);
    return result;
  };
}

async function runRequest(
  fetchImpl: typeof fetch,
  url: string,
  request: GateRequest,
  controller: AbortController,
  baseHeaders: Record<string, string>,
): Promise<GateResponse> {
  try {
    const resp = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...baseHeaders },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    if (!resp.ok) {
      return denyWithReason(request, `callback_status_${resp.status}`);
    }
    const body = (await resp.json()) as unknown;
    if (!isGateResponse(body)) {
      return denyWithReason(request, 'callback_invalid_response');
    }
    return body;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return denyWithReason(request, 'gate_timeout');
    }
    const msg = err instanceof Error ? err.message : String(err);
    return denyWithReason(request, `callback_error:${msg}`);
  }
}

function denyWithReason(request: GateRequest, reason: string): GateResponse {
  return {
    decision: 'deny',
    reason,
    granularity: request.granularity,
  };
}

function isGateResponse(v: unknown): v is GateResponse {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  const validDecisions = ['allow', 'allow_session', 'allow_forever', 'deny', 'ban_forever'];
  if (typeof obj.decision !== 'string' || !validDecisions.includes(obj.decision)) {
    return false;
  }
  const validGranularities = ['tool', 'toolkit', 'category'];
  if (typeof obj.granularity !== 'string' || !validGranularities.includes(obj.granularity)) {
    return false;
  }
  if (obj.reason !== undefined && typeof obj.reason !== 'string') return false;
  if (obj.operator_id !== undefined && typeof obj.operator_id !== 'string') return false;
  return true;
}
