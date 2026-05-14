import { describe, expect, it } from 'vitest';

import { programmaticGate } from '../../src/gate/programmatic.js';
import type { GateRequest } from '../../src/gate/types.js';

function req(o: Partial<GateRequest> = {}): GateRequest {
  return {
    event_id: 'evt_x',
    tool_name: 't',
    tool_args: {},
    agent_id: 'a',
    session_id: 's',
    granularity: 'tool',
    ...o,
  };
}

describe('programmaticGate', () => {
  it('passes the request to the handler and returns the response', async () => {
    const gate = programmaticGate(async (r) => ({
      decision: 'allow',
      granularity: r.granularity,
      operator_id: 'op',
    }));
    const r = await gate(req());
    expect(r.decision).toBe('allow');
    expect(r.operator_id).toBe('op');
  });

  it('accepts synchronous handlers', async () => {
    const gate = programmaticGate((r) => ({
      decision: 'deny',
      granularity: r.granularity,
    }));
    const r = await gate(req());
    expect(r.decision).toBe('deny');
  });

  it('downgrades response granularity that escalates the request', async () => {
    // Request was for `tool`; handler responded with `toolkit` — library
    // forces it back to `tool` to enforce SPEC §4.3 no-escalate rule.
    const gate = programmaticGate(async () => ({
      decision: 'allow_forever',
      granularity: 'toolkit',
    }));
    const r = await gate(req({ granularity: 'tool' }));
    expect(r.granularity).toBe('tool');
  });

  it('does not modify a response with matching granularity', async () => {
    const gate = programmaticGate(async () => ({
      decision: 'allow_session',
      granularity: 'toolkit',
    }));
    const r = await gate(req({ granularity: 'toolkit' }));
    expect(r.granularity).toBe('toolkit');
  });
});
