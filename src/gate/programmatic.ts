/**
 * programmaticGate — wraps an arbitrary handler. SPEC §4.3.
 *
 * Use when the host application has its own UI (Electron renderer, mobile RN
 * modal, etc.) and the gate is "just call this function and wait."
 */

import type { ApprovalGate, GateRequest, GateResponse } from './types.js';

export function programmaticGate(
  handler: (request: GateRequest) => Promise<GateResponse> | GateResponse,
): ApprovalGate {
  return async (request: GateRequest): Promise<GateResponse> => {
    const response = await handler(request);
    if (response.granularity !== request.granularity) {
      // SPEC §4.3: gate may not escalate granularity. The library defends by
      // downgrading any wider response to the requested granularity rather
      // than throwing — this preserves liveness while preventing escalation.
      // (A more conservative deployment can wrap the handler to throw.)
      return { ...response, granularity: request.granularity };
    }
    return response;
  };
}
