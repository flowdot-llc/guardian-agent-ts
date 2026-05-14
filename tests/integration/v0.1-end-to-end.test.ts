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
  tmp = await mkdtemp(join(tmpdir(), 'guardian-e2e-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('v0.1 end-to-end', () => {
  it('runs a multi-tool agent flow, then halts mid-stream', async () => {
    const path = join(tmp, 'audit.jsonl');
    const audit = new AuditLogWriter({ path, agentId: 'a', sessionId: 's1' });
    const estop = new EStopLocal({ audit });
    const rt = new GuardianRuntime({ agentId: 'a', sessionId: 's1', audit, estop });

    const lookup = rt.tool(
      async (id: string) => ({ id, value: `value-of-${id}` }),
      { name: 'lookup' },
    );
    const transform = rt.tool(
      async (s: string) => s.toUpperCase(),
      { name: 'transform' },
    );

    // First two calls succeed.
    expect(await lookup('a')).toEqual({ id: 'a', value: 'value-of-a' });
    expect(await transform('hello')).toBe('HELLO');

    // Press estop.
    await rt.pressEStop({ reason: 'soak_complete' });

    // Subsequent calls fail with halt.
    await expect(lookup('b')).rejects.toBeInstanceOf(GuardianHaltedError);

    await rt.close();

    // Read everything back; verify the chain.
    const reader = await AuditLogReader.open(path);
    const count = await reader.verifyChain();
    await reader.close();
    expect(count).toBeGreaterThan(0);

    // Read records and assert the expected sequence shape.
    const reader2 = await AuditLogReader.open(path);
    const records = [];
    for await (const r of reader2.records()) records.push(r);
    await reader2.close();

    const kinds = records.map((r) => r.kind);
    expect(kinds[0]).toBe('session_open');
    // The press should appear before the halted policy_check.
    const pressIdx = kinds.indexOf('estop_press');
    const haltIdx = kinds.lastIndexOf('policy_check');
    expect(pressIdx).toBeLessThan(haltIdx);
    expect(records[haltIdx]?.status).toBe('halted');
    expect(kinds[kinds.length - 1]).toBe('session_close');
  });

  it('persists across runtime restart', async () => {
    const path = join(tmp, 'audit.jsonl');

    // First run.
    {
      const audit = new AuditLogWriter({ path, agentId: 'a', sessionId: 's1' });
      const rt = new GuardianRuntime({ agentId: 'a', sessionId: 's1', audit });
      const t = rt.tool(async () => 1, { name: 'one' });
      await t();
      await rt.close();
    }

    // Second run — append continues the chain.
    {
      const audit = new AuditLogWriter({ path, agentId: 'a', sessionId: 's2' });
      const rt = new GuardianRuntime({ agentId: 'a', sessionId: 's2', audit });
      const t = rt.tool(async () => 2, { name: 'two' });
      await t();
      await rt.close();
    }

    const reader = await AuditLogReader.open(path);
    const count = await reader.verifyChain();
    await reader.close();
    expect(count).toBeGreaterThan(6); // two sessions, each with multiple events
  });
});
