/**
 * Two-key operator authorization. SPEC §4.5 (v0.4.0+).
 *
 * For tool dispatches that require fresh operator confirmation before
 * proceeding (analogous to `sudo` for AI agents, or the Hub's
 * `password.confirm` gate for `panic_clear`), the runtime suspends the
 * call, writes a `policy_check { status: pending_operator }` audit row
 * with a unique `gate_id`, and calls the configured
 * `OperatorConfirmationGate.request()`. The gate's response — approved or
 * denied — resolves the suspended call. A timeout is treated as denied
 * (fail-closed).
 *
 * The library defines the suspend/resume + timeout mechanism. The actual
 * transport (HTTP webhook, IPC frame to a UI process, LiveKit data
 * channel, Hub-side password.confirm endpoint) is consumer-supplied. The
 * library ships:
 *
 *   - `OperatorConfirmationGate` interface (one method, `request`)
 *   - `callbackOperatorGate(fn)` reference adapter (wraps a plain JS callback)
 *   - `denyAllOperatorGate()` reference adapter (defensive fallback)
 *
 * Pure mechanism: blocking wait on an external signal, hard timeout, audit
 * lifecycle. No reasoning about whether the call is safe — only that this
 * class of call requires a human.
 */

import { ulid } from 'ulidx';

/**
 * Payload supplied to the gate when a suspended call asks for confirmation.
 */
export interface OperatorConfirmationRequest {
  /** Stable correlation id. Matches `detail.gate_id` on the pending audit row. */
  gate_id: string;
  /** Tool that would be dispatched if approved. */
  tool_name: string;
  /** Tool's args (CALLER REDACTED — same shape that lands in audit). */
  tool_args: Record<string, unknown>;
  /** Human-readable reason this gate fired (rule id, capability name, etc.). */
  reason: string;
  /** Hard timeout in ms. Library enforces this; gate MAY return sooner. */
  timeout_ms: number;
  /** Agent id stamped on the audit row. */
  agent_id: string;
  /** Session id stamped on the audit row. */
  session_id: string;
}

/**
 * Response from the gate. Library accepts the decision verbatim; on timeout
 * the library synthesizes `{ decision: 'denied', reason: 'timeout' }`.
 */
export interface OperatorConfirmationResponse {
  decision: 'approved' | 'denied';
  /** Free-text id of the operator (auth subject, hostname, etc.). */
  operator_id?: string;
  /** Free-text reason; primarily for denied + timeout cases. */
  reason?: string;
}

/**
 * The contract a consumer implements. One method.
 *
 * Implementations MUST NOT mutate `request`. Implementations MAY block as
 * long as they like; the library enforces `timeout_ms` independently via
 * Promise.race.
 */
export interface OperatorConfirmationGate {
  request(
    req: OperatorConfirmationRequest,
  ): Promise<OperatorConfirmationResponse> | OperatorConfirmationResponse;
}

/**
 * Wrap a callback as a gate. Useful for in-process testing, simple consumer
 * setups, and the "operator types y/n in the terminal" pattern.
 *
 * The callback receives the request; whatever it resolves/returns becomes
 * the response.
 */
export function callbackOperatorGate(
  fn: (
    req: OperatorConfirmationRequest,
  ) => Promise<OperatorConfirmationResponse> | OperatorConfirmationResponse,
): OperatorConfirmationGate {
  return { request: fn };
}

/**
 * Reference gate that denies every request. Defensive fallback used when
 * the consumer wants `requiresOperatorConfirmation: true` to fail-closed
 * (e.g., CI environments with no operator transport wired).
 */
export function denyAllOperatorGate(reason = 'no operator gate configured'): OperatorConfirmationGate {
  return {
    request: () => ({ decision: 'denied', reason }),
  };
}

/**
 * Generate a fresh gate_id. Exposed for tests; runtime calls this internally.
 */
export function newGateId(): string {
  return 'gt_' + ulid();
}

/**
 * Race a gate response against a timeout. Returns the gate's response, or
 * a synthesized `denied/timeout` response after `timeout_ms`. Internal —
 * the runtime uses this; exposed for tests.
 */
export async function awaitWithTimeout(
  gate: OperatorConfirmationGate,
  request: OperatorConfirmationRequest,
): Promise<OperatorConfirmationResponse> {
  const timeoutMs = request.timeout_ms;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<OperatorConfirmationResponse>((resolve) => {
    timer = setTimeout(() => {
      resolve({ decision: 'denied', reason: 'timeout' });
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([
      Promise.resolve(gate.request(request)),
      timeout,
    ]);
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
