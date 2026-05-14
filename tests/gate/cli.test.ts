import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { cliApprovalGate, parseCliAnswer } from '../../src/gate/cli.js';
import type { GateRequest } from '../../src/gate/types.js';

function makeRequest(overrides: Partial<GateRequest> = {}): GateRequest {
  return {
    event_id: 'evt_x',
    tool_name: 'tool.x',
    tool_args: { y: 1 },
    agent_id: 'a',
    session_id: 's',
    granularity: 'tool',
    ...overrides,
  };
}

async function runGateWith(
  answer: string,
  reqOverrides: Partial<GateRequest> = {},
  operatorId?: string,
): Promise<{ response: { decision: string; granularity: string; operator_id?: string }; output: string }> {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on('data', (c: Buffer) => chunks.push(c));

  const gate = cliApprovalGate(operatorId ? { input, output, operatorId } : { input, output });
  const pending = gate(makeRequest(reqOverrides));

  // Wait a microtask so the prompt is written.
  await new Promise((r) => setImmediate(r));
  input.write(answer + '\n');
  input.end();

  const response = await pending;
  return { response, output: Buffer.concat(chunks).toString('utf-8') };
}

describe('parseCliAnswer', () => {
  it('maps once/1/allow/y/yes to allow', () => {
    expect(parseCliAnswer('1')).toBe('allow');
    expect(parseCliAnswer('once')).toBe('allow');
    expect(parseCliAnswer('allow')).toBe('allow');
    expect(parseCliAnswer('y')).toBe('allow');
    expect(parseCliAnswer('yes')).toBe('allow');
    expect(parseCliAnswer('YES')).toBe('allow');
  });

  it('maps 2/session to allow_session', () => {
    expect(parseCliAnswer('2')).toBe('allow_session');
    expect(parseCliAnswer('session')).toBe('allow_session');
  });

  it('maps 3/forever/always to allow_forever', () => {
    expect(parseCliAnswer('3')).toBe('allow_forever');
    expect(parseCliAnswer('forever')).toBe('allow_forever');
    expect(parseCliAnswer('always')).toBe('allow_forever');
    expect(parseCliAnswer('always_allow')).toBe('allow_forever');
  });

  it('maps 5/ban/never to ban_forever', () => {
    expect(parseCliAnswer('5')).toBe('ban_forever');
    expect(parseCliAnswer('ban')).toBe('ban_forever');
    expect(parseCliAnswer('never')).toBe('ban_forever');
    expect(parseCliAnswer('ban_forever')).toBe('ban_forever');
  });

  it('defaults unknown / 4 / deny / no to deny (fail-closed)', () => {
    expect(parseCliAnswer('4')).toBe('deny');
    expect(parseCliAnswer('deny')).toBe('deny');
    expect(parseCliAnswer('no')).toBe('deny');
    expect(parseCliAnswer('')).toBe('deny');
    expect(parseCliAnswer('???')).toBe('deny');
  });
});

describe('cliApprovalGate (integration via PassThrough streams)', () => {
  it('writes a prompt with tool, agent, args', async () => {
    const { output } = await runGateWith('1');
    expect(output).toContain('approval required');
    expect(output).toContain('tool.x');
    expect(output).toContain('agent: ' === '' ? 'never' : 'Agent');
    expect(output).toContain('"y":1');
  });

  it('returns allow on input "1"', async () => {
    const { response } = await runGateWith('1');
    expect(response.decision).toBe('allow');
    expect(response.granularity).toBe('tool');
    expect(response.operator_id).toBeUndefined();
  });

  it('returns allow_session on input "session"', async () => {
    const { response } = await runGateWith('session');
    expect(response.decision).toBe('allow_session');
  });

  it('returns ban_forever on input "ban"', async () => {
    const { response } = await runGateWith('ban');
    expect(response.decision).toBe('ban_forever');
  });

  it('records operator_id when configured', async () => {
    const { response } = await runGateWith('1', {}, 'op_alpha');
    expect(response.operator_id).toBe('op_alpha');
  });

  it('shows model line when model attribution is present', async () => {
    const { output } = await runGateWith('1', {
      model: { provider: 'anthropic', id: 'claude-opus-4' },
    });
    expect(output).toContain('anthropic/claude-opus-4');
  });

  it('shows context line when context is present', async () => {
    const { output } = await runGateWith('1', { context: 'planning step 3' });
    expect(output).toContain('planning step 3');
  });

  it('falls back to process.stdin / process.stderr when not configured', () => {
    // Just constructing the gate exercises the default branches. We don't
    // invoke it (that would read real stdin).
    const gate = cliApprovalGate();
    expect(typeof gate).toBe('function');
  });
});
