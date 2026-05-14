import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditLogWriter } from '../../src/audit/writer.js';
import { AuditLogReader } from '../../src/audit/reader.js';
import { EStopLocal } from '../../src/estop/local.js';
import { GuardianRuntime } from '../../src/runtime/runtime.js';
import { GuardianHaltedError } from '../../src/errors.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'guardian-runtime-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function readAll(path: string) {
  const reader = await AuditLogReader.open(path);
  const records = [];
  for await (const r of reader.records()) records.push(r);
  await reader.close();
  return records;
}

describe('GuardianRuntime', () => {
  it('opens a session on first tool call', async () => {
    const path = join(tmp, 'audit.jsonl');
    const audit = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const rt = new GuardianRuntime({ agentId: 'a', sessionId: 's', audit });
    const inc = rt.tool(async (x: number) => x + 1, { name: 'inc' });
    expect(await inc(2)).toBe(3);
    await rt.close();

    const recs = await readAll(path);
    expect(recs[0]?.kind).toBe('session_open');
    expect(recs[recs.length - 1]?.kind).toBe('session_close');
  });

  it('emits tool_call → policy_check → tool_result for a successful call', async () => {
    const path = join(tmp, 'audit.jsonl');
    const audit = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const rt = new GuardianRuntime({ agentId: 'a', sessionId: 's', audit });
    const adder = rt.tool(async (x: number) => x + 10, { name: 'adder' });
    expect(await adder(5)).toBe(15);
    await rt.close();

    const recs = await readAll(path);
    const kinds = recs.map((r) => r.kind);
    expect(kinds).toEqual([
      'session_open',
      'tool_call',
      'policy_check',
      'tool_result',
      'session_close',
    ]);
    const toolResult = recs.find((r) => r.kind === 'tool_result');
    expect(toolResult?.status).toBe('executed');
    expect(toolResult?.tool?.result).toBe(15);
    expect(toolResult?.tool?.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('records tool_result errored on throw and re-throws', async () => {
    const path = join(tmp, 'audit.jsonl');
    const audit = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const rt = new GuardianRuntime({ agentId: 'a', sessionId: 's', audit });
    const broken = rt.tool(async () => {
      throw new Error('boom');
    }, { name: 'broken' });

    await expect(broken()).rejects.toThrow(/boom/);
    await rt.close();

    const recs = await readAll(path);
    const result = recs.find((r) => r.kind === 'tool_result');
    expect(result?.status).toBe('errored');
    expect(result?.detail).toMatchObject({ error: 'boom' });
  });

  it('handles non-Error throws by stringifying', async () => {
    const path = join(tmp, 'audit.jsonl');
    const audit = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const rt = new GuardianRuntime({ agentId: 'a', sessionId: 's', audit });
    const weird = rt.tool(async () => {
      throw 'just a string';
    }, { name: 'weird' });

    await expect(weird()).rejects.toBe('just a string');
    await rt.close();

    const recs = await readAll(path);
    const result = recs.find((r) => r.kind === 'tool_result');
    expect(result?.detail).toMatchObject({ error: 'just a string' });
  });

  it('refuses tool call when estop is pressed', async () => {
    const path = join(tmp, 'audit.jsonl');
    const audit = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const estop = new EStopLocal({ audit, initiallyPressed: true });
    const rt = new GuardianRuntime({ agentId: 'a', sessionId: 's', audit, estop });
    const noop = rt.tool(async () => 1, { name: 'noop' });

    await expect(noop()).rejects.toBeInstanceOf(GuardianHaltedError);
    await rt.close();

    const recs = await readAll(path);
    const halted = recs.find((r) => r.kind === 'policy_check' && r.status === 'halted');
    expect(halted).toBeDefined();
    expect(halted?.detail).toMatchObject({ reason: 'estop' });
  });

  it('pressEStop fires through to the local estop', async () => {
    const path = join(tmp, 'audit.jsonl');
    const audit = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const estop = new EStopLocal({ audit });
    const rt = new GuardianRuntime({ agentId: 'a', sessionId: 's', audit, estop });
    await rt.pressEStop({ reason: 'manual' });
    expect(estop.isPressed()).toBe(true);
    await rt.close();
  });

  it('pressEStop throws when no estop attached', async () => {
    const path = join(tmp, 'audit.jsonl');
    const audit = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const rt = new GuardianRuntime({ agentId: 'a', sessionId: 's', audit });
    await expect(rt.pressEStop({ reason: 'r' })).rejects.toThrow(/without an EStopLocal/);
    await rt.close();
  });

  it('rejects reserved tool name prefixes', async () => {
    const path = join(tmp, 'audit.jsonl');
    const audit = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const rt = new GuardianRuntime({ agentId: 'a', sessionId: 's', audit });
    expect(() => rt.tool(async () => 1, { name: 'guardian.foo' })).toThrow(/reserved/);
    expect(() => rt.tool(async () => 1, { name: 'runtime.bar' })).toThrow(/reserved/);
    expect(() => rt.tool(async () => 1, { name: 'internal.baz' })).toThrow(/reserved/);
    await rt.close();
  });

  it('requires a tool name', async () => {
    const path = join(tmp, 'audit.jsonl');
    const audit = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const rt = new GuardianRuntime({ agentId: 'a', sessionId: 's', audit });
    // Function with empty name and no opts.name.
    const anon = (async () => 1) as () => Promise<number>;
    Object.defineProperty(anon, 'name', { value: '' });
    expect(() => rt.tool(anon)).toThrow(/requires a name/);
    await rt.close();
  });

  it('uses fn.name when opts.name omitted', async () => {
    const path = join(tmp, 'audit.jsonl');
    const audit = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const rt = new GuardianRuntime({ agentId: 'a', sessionId: 's', audit });
    async function myTool() {
      return 'ok';
    }
    const wrapped = rt.tool(myTool);
    expect(await wrapped()).toBe('ok');
    await rt.close();

    const recs = await readAll(path);
    const toolCall = recs.find((r) => r.kind === 'tool_call');
    expect(toolCall?.tool?.name).toBe('myTool');
  });

  it('records model attribution from opts.model', async () => {
    const path = join(tmp, 'audit.jsonl');
    const audit = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const rt = new GuardianRuntime({ agentId: 'a', sessionId: 's', audit });
    const t = rt.tool(async () => 1, {
      name: 't',
      model: { provider: 'anthropic', id: 'claude-opus-4', inputTokens: 100, outputTokens: 50 },
    });
    await t();
    await rt.close();

    const recs = await readAll(path);
    const call = recs.find((r) => r.kind === 'tool_call');
    expect(call?.model).toEqual({
      provider: 'anthropic',
      id: 'claude-opus-4',
      input_tokens: 100,
      output_tokens: 50,
    });
  });

  it('uses defaultModel from runtime when opts.model omitted', async () => {
    const path = join(tmp, 'audit.jsonl');
    const audit = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const rt = new GuardianRuntime({
      agentId: 'a',
      sessionId: 's',
      audit,
      defaultModel: { provider: 'openai', id: 'gpt-5' },
    });
    const t = rt.tool(async () => 1, { name: 't' });
    await t();
    await rt.close();

    const recs = await readAll(path);
    const call = recs.find((r) => r.kind === 'tool_call');
    expect(call?.model).toEqual({ provider: 'openai', id: 'gpt-5' });
  });

  it('records args as object with positional keys', async () => {
    const path = join(tmp, 'audit.jsonl');
    const audit = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const rt = new GuardianRuntime({ agentId: 'a', sessionId: 's', audit });
    const t = rt.tool(async (x: number, y: string) => `${x}:${y}`, { name: 't' });
    await t(7, 'hi');
    await rt.close();

    const recs = await readAll(path);
    const call = recs.find((r) => r.kind === 'tool_call');
    expect(call?.tool?.args).toEqual({ '0': 7, '1': 'hi' });
  });

  it('generates sessionId automatically when omitted', () => {
    const path = join(tmp, 'audit.jsonl');
    const audit = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const rt = new GuardianRuntime({ agentId: 'a', audit });
    expect(rt.sessionId).toMatch(/^sess_/);
  });

  it('close is idempotent', async () => {
    const path = join(tmp, 'audit.jsonl');
    const audit = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const rt = new GuardianRuntime({ agentId: 'a', sessionId: 's', audit });
    await rt.close();
    await rt.close();
  });

  it('openSession is idempotent and runs implicitly', async () => {
    const path = join(tmp, 'audit.jsonl');
    const audit = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const rt = new GuardianRuntime({ agentId: 'a', sessionId: 's', audit });
    await rt.openSession();
    await rt.openSession();
    await rt.close();

    const recs = await readAll(path);
    // Only one session_open even after two explicit calls.
    const opens = recs.filter((r) => r.kind === 'session_open');
    expect(opens).toHaveLength(1);
  });

  it('does not emit session_close if session was never opened', async () => {
    const path = join(tmp, 'audit.jsonl');
    const audit = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const rt = new GuardianRuntime({ agentId: 'a', sessionId: 's', audit });
    await rt.close();

    // No appends → either no file at all, or an empty file. Both are "0 records".
    if (existsSync(path)) {
      const recs = await readAll(path);
      expect(recs).toHaveLength(0);
    }
  });
});
