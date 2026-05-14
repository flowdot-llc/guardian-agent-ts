import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditLogReader } from '../../src/audit/reader.js';
import { AuditLogWriter } from '../../src/audit/writer.js';
import { GuardianHaltedError } from '../../src/errors.js';
import { GuardianRuntime } from '../../src/runtime/runtime.js';
import {
  awaitWithTimeout,
  callbackOperatorGate,
  denyAllOperatorGate,
  newGateId,
  type OperatorConfirmationGate,
  type OperatorConfirmationRequest,
  type OperatorConfirmationResponse,
} from '../../src/gate/two-key.js';
import type { AuditRecord } from '../../src/types.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'two-key-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function readAll(path: string): Promise<AuditRecord[]> {
  const reader = await AuditLogReader.open(path);
  const out: AuditRecord[] = [];
  for await (const r of reader.records()) out.push(r);
  await reader.close();
  return out;
}

describe('newGateId', () => {
  it('produces a gt_-prefixed ulid', () => {
    const id = newGateId();
    expect(id).toMatch(/^gt_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('produces unique ids', () => {
    const a = newGateId();
    const b = newGateId();
    expect(a).not.toBe(b);
  });
});

describe('callbackOperatorGate', () => {
  it('wraps a sync callback', async () => {
    const gate = callbackOperatorGate(() => ({ decision: 'approved', operator_id: 'alice' }));
    const r = await gate.request({
      gate_id: 'gt_test',
      tool_name: 't',
      tool_args: {},
      reason: 'x',
      timeout_ms: 1000,
      agent_id: 'a',
      session_id: 's',
    });
    expect(r).toEqual({ decision: 'approved', operator_id: 'alice' });
  });

  it('wraps an async callback', async () => {
    const gate = callbackOperatorGate(async () => ({ decision: 'denied', reason: 'no' }));
    const r = await gate.request({
      gate_id: 'gt_test',
      tool_name: 't',
      tool_args: {},
      reason: 'x',
      timeout_ms: 1000,
      agent_id: 'a',
      session_id: 's',
    });
    expect(r.decision).toBe('denied');
  });
});

describe('denyAllOperatorGate', () => {
  it('always denies with the configured reason', async () => {
    const gate = denyAllOperatorGate('CI: no operator');
    const r = await gate.request({
      gate_id: 'g',
      tool_name: 't',
      tool_args: {},
      reason: 'x',
      timeout_ms: 1000,
      agent_id: 'a',
      session_id: 's',
    });
    expect(r).toEqual({ decision: 'denied', reason: 'CI: no operator' });
  });

  it('has a sensible default reason', async () => {
    const gate = denyAllOperatorGate();
    const r = await gate.request({
      gate_id: 'g',
      tool_name: 't',
      tool_args: {},
      reason: 'x',
      timeout_ms: 1000,
      agent_id: 'a',
      session_id: 's',
    });
    expect(r.reason).toBeDefined();
  });
});

describe('awaitWithTimeout', () => {
  const req: OperatorConfirmationRequest = {
    gate_id: 'g',
    tool_name: 't',
    tool_args: {},
    reason: 'x',
    timeout_ms: 100,
    agent_id: 'a',
    session_id: 's',
  };

  it('returns the gate response when it resolves before timeout', async () => {
    const fast: OperatorConfirmationGate = {
      request: async () => ({ decision: 'approved', operator_id: 'op1' }),
    };
    const r = await awaitWithTimeout(fast, req);
    expect(r).toEqual({ decision: 'approved', operator_id: 'op1' });
  });

  it('returns denied/timeout when the gate is slower than timeout_ms', async () => {
    const slow: OperatorConfirmationGate = {
      request: () =>
        new Promise<OperatorConfirmationResponse>((resolve) => {
          setTimeout(() => resolve({ decision: 'approved' }), 500);
        }),
    };
    const r = await awaitWithTimeout(slow, req);
    expect(r).toEqual({ decision: 'denied', reason: 'timeout' });
  });
});

describe('GuardianRuntime + operator gate', () => {
  it('writes pending_operator → approved → tool_call → tool_result when gate approves', async () => {
    const path = join(tmp, 'audit.jsonl');
    const audit = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const gate = callbackOperatorGate(() => ({ decision: 'approved', operator_id: 'alice' }));
    const rt = new GuardianRuntime({
      agentId: 'a',
      sessionId: 's',
      audit,
      operatorGate: gate,
    });
    const t = rt.tool(async () => 'dispatched', {
      name: 'sensitive',
      requiresOperatorConfirmation: true,
      operatorConfirmationReason: 'capability_redline',
    });
    const r = await t();
    expect(r).toBe('dispatched');
    await rt.close();

    const recs = await readAll(path);
    const kinds = recs.map((r) => `${r.kind}:${r.status}`);
    // Expect: session_open, policy_check:pending_operator,
    // policy_check:approved, tool_call:pending,
    // policy_check:approved (the fail-open one), tool_result, session_close
    expect(kinds).toContain('policy_check:pending_operator');
    expect(kinds).toContain('policy_check:approved');
    expect(kinds).toContain('tool_call:pending');
    expect(kinds).toContain('tool_result:executed');
    // gate_id correlation: pending_operator and resolution share gate_id
    const pending = recs.find((r) => r.status === 'pending_operator');
    const approved = recs.find(
      (r) => r.kind === 'policy_check' && r.status === 'approved' && r.detail?.gate_id,
    );
    expect(approved?.detail?.gate_id).toBe(pending?.detail?.gate_id);
    expect(approved?.detail?.operator_id).toBe('alice');
  });

  it('throws + writes denied when gate denies', async () => {
    const path = join(tmp, 'audit.jsonl');
    const audit = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const gate = denyAllOperatorGate('operator denied');
    const rt = new GuardianRuntime({
      agentId: 'a',
      sessionId: 's',
      audit,
      operatorGate: gate,
    });
    const t = rt.tool(async () => 'should not run', {
      name: 'sensitive',
      requiresOperatorConfirmation: true,
      operatorConfirmationReason: 'capability_redline',
    });
    await expect(t()).rejects.toBeInstanceOf(GuardianHaltedError);
    await rt.close();

    const recs = await readAll(path);
    const denied = recs.find(
      (r) => r.kind === 'policy_check' && r.status === 'denied' && r.detail?.gate_id,
    );
    expect(denied).toBeDefined();
    expect(denied?.detail?.reason).toBe('operator denied');
    // tool_call must NOT have fired
    expect(recs.some((r) => r.kind === 'tool_call')).toBe(false);
  });

  it('treats timeout as denied', async () => {
    const path = join(tmp, 'audit.jsonl');
    const audit = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const slow: OperatorConfirmationGate = {
      request: () =>
        new Promise<OperatorConfirmationResponse>((resolve) => {
          setTimeout(() => resolve({ decision: 'approved' }), 500);
        }),
    };
    const rt = new GuardianRuntime({
      agentId: 'a',
      sessionId: 's',
      audit,
      operatorGate: slow,
      operatorTimeoutMs: 50,
    });
    const t = rt.tool(async () => 'never', {
      name: 'sensitive',
      requiresOperatorConfirmation: true,
    });
    await expect(t()).rejects.toThrow(/timed out/);
    await rt.close();

    const recs = await readAll(path);
    const denied = recs.find((r) => r.kind === 'policy_check' && r.status === 'denied');
    expect(denied?.detail?.reason).toBe('timeout');
  });

  it('per-call timeout override wins over runtime default', async () => {
    const path = join(tmp, 'audit.jsonl');
    const audit = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const slow: OperatorConfirmationGate = {
      request: () =>
        new Promise<OperatorConfirmationResponse>((resolve) => {
          setTimeout(() => resolve({ decision: 'approved' }), 500);
        }),
    };
    const rt = new GuardianRuntime({
      agentId: 'a',
      sessionId: 's',
      audit,
      operatorGate: slow,
      operatorTimeoutMs: 10_000, // generous runtime default
    });
    const t = rt.tool(async () => 'never', {
      name: 'sensitive',
      requiresOperatorConfirmation: true,
      operatorConfirmationTimeoutMs: 25, // tight per-call
    });
    const start = Date.now();
    await expect(t()).rejects.toThrow(/timed out/);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(200);
    await rt.close();
  });

  it('throws config error when requiresOperatorConfirmation is set but no gate configured', async () => {
    const path = join(tmp, 'audit.jsonl');
    const audit = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const rt = new GuardianRuntime({ agentId: 'a', sessionId: 's', audit });
    const t = rt.tool(async () => 'never', {
      name: 'sensitive',
      requiresOperatorConfirmation: true,
    });
    await expect(t()).rejects.toThrow(/no operatorGate is configured/);
    await rt.close();
  });

  it('falls back to "unspecified" reason when none supplied', async () => {
    const path = join(tmp, 'audit.jsonl');
    const audit = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const gate = callbackOperatorGate(() => ({ decision: 'approved' }));
    const rt = new GuardianRuntime({ agentId: 'a', sessionId: 's', audit, operatorGate: gate });
    const t = rt.tool(async () => 'ok', {
      name: 'sensitive',
      requiresOperatorConfirmation: true,
    });
    await t();
    await rt.close();
    const recs = await readAll(path);
    const pending = recs.find((r) => r.status === 'pending_operator');
    expect(pending?.detail?.reason).toBe('unspecified');
  });

  it('denied response without reason still throws cleanly', async () => {
    const path = join(tmp, 'audit.jsonl');
    const audit = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const gate = callbackOperatorGate(() => ({ decision: 'denied' })); // no reason
    const rt = new GuardianRuntime({ agentId: 'a', sessionId: 's', audit, operatorGate: gate });
    const t = rt.tool(async () => 'never', {
      name: 'sensitive',
      requiresOperatorConfirmation: true,
    });
    await expect(t()).rejects.toThrow(/operator denied/);
    await rt.close();
  });

  it('runtime without operator gate ignores tools that do NOT require confirmation', async () => {
    const path = join(tmp, 'audit.jsonl');
    const audit = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const rt = new GuardianRuntime({ agentId: 'a', sessionId: 's', audit });
    const t = rt.tool(async () => 'ok', { name: 'normal' });
    await t();
    await rt.close();
    const recs = await readAll(path);
    expect(recs.some((r) => r.status === 'pending_operator')).toBe(false);
  });
});
