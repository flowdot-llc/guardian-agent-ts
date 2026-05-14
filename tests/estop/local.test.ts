import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditLogWriter } from '../../src/audit/writer.js';
import { AuditLogReader } from '../../src/audit/reader.js';
import { EStopLocal } from '../../src/estop/local.js';
import type { Notifier } from '../../src/notify/types.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'guardian-estop-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('EStopLocal', () => {
  it('starts not pressed by default', () => {
    const e = new EStopLocal();
    expect(e.isPressed()).toBe(false);
    expect(e.getState().pressed).toBe(false);
    expect(e.abortSignal.aborted).toBe(false);
  });

  it('supports initiallyPressed for tests', () => {
    const e = new EStopLocal({ initiallyPressed: true });
    expect(e.isPressed()).toBe(true);
    expect(e.abortSignal.aborted).toBe(true);
  });

  it('press transitions to pressed + aborts the signal', async () => {
    const e = new EStopLocal();
    const r = await e.press({ reason: 'manual_halt' });
    expect(e.isPressed()).toBe(true);
    expect(r.state.pressedReason).toBe('manual_halt');
    expect(e.abortSignal.aborted).toBe(true);
  });

  it('press records audit event when audit provided', async () => {
    const path = join(tmp, 'audit.jsonl');
    const audit = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const e = new EStopLocal({ audit });
    await e.press({ reason: 'shutdown', operatorId: 'op_1', detail: { ip: '10.0.0.1' } });
    await audit.close();

    const reader = await AuditLogReader.open(path);
    const records = [];
    for await (const r of reader.records()) records.push(r);
    await reader.close();

    expect(records).toHaveLength(1);
    expect(records[0]?.kind).toBe('estop_press');
    expect(records[0]?.status).toBe('halted');
    expect(records[0]?.initiator).toBe('operator');
    expect(records[0]?.detail).toMatchObject({
      reason: 'shutdown',
      operator_id: 'op_1',
      ip: '10.0.0.1',
    });
  });

  it('press is idempotent: a second press records audit but does not change state shape', async () => {
    const path = join(tmp, 'audit.jsonl');
    const audit = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const e = new EStopLocal({ audit });

    await e.press({ reason: 'first' });
    const before = e.getState();
    await e.press({ reason: 'second' });
    const after = e.getState();
    await audit.close();

    // pressedAt and reason from the first press are preserved.
    expect(after.pressedAt).toBe(before.pressedAt);
    expect(after.pressedReason).toBe('first');

    // Two audit rows.
    const reader = await AuditLogReader.open(path);
    const records = [];
    for await (const r of reader.records()) records.push(r);
    await reader.close();
    expect(records).toHaveLength(2);
  });

  it('clear transitions to cleared but keeps the abort signal aborted', async () => {
    const e = new EStopLocal();
    await e.press({ reason: 'r' });
    const r = await e.clear({ operatorId: 'op_1' });

    expect(r.state.pressed).toBe(false);
    expect(r.state.clearedAt).toBeDefined();
    // Recovery requires a new instance per SPEC §5.3 — signal stays aborted.
    expect(e.abortSignal.aborted).toBe(true);
  });

  it('clear is no-op when not pressed (no audit row)', async () => {
    const path = join(tmp, 'audit.jsonl');
    const audit = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const e = new EStopLocal({ audit });

    const r = await e.clear({});
    expect(r.state.pressed).toBe(false);
    await audit.close();

    // No-op clear must not have created an audit row. Either no file at all,
    // or an empty file — both represent "no records".
    if (existsSync(path)) {
      const reader = await AuditLogReader.open(path);
      const records = [];
      for await (const x of reader.records()) records.push(x);
      await reader.close();
      expect(records).toHaveLength(0);
    }
  });

  it('fires notifier on press and clear', async () => {
    const events: string[] = [];
    const notifier: Notifier = {
      notify: vi.fn(async (ev) => {
        events.push(ev.kind);
      }),
    };
    const e = new EStopLocal({ notifier });
    await e.press({ reason: 'r' });
    await e.clear({});

    expect(events).toEqual(['estop_press', 'estop_clear']);
    expect(notifier.notify).toHaveBeenCalledTimes(2);
  });

  it('press with audit + notifier + operatorId covers all branches', async () => {
    const path = join(tmp, 'audit.jsonl');
    const audit = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const calls: { kind: string; operatorId?: unknown }[] = [];
    const notifier: Notifier = {
      notify: vi.fn(async (ev) => {
        calls.push({ kind: ev.kind, operatorId: ev.summary.operator_id });
      }),
    };
    const e = new EStopLocal({ audit, notifier });
    await e.press({ reason: 'r', operatorId: 'op_x' });
    await e.clear({ operatorId: 'op_y' });
    await audit.close();

    expect(calls).toEqual([
      { kind: 'estop_press', operatorId: 'op_x' },
      { kind: 'estop_clear', operatorId: 'op_y' },
    ]);

    const reader = await AuditLogReader.open(path);
    const records = [];
    for await (const r of reader.records()) records.push(r);
    await reader.close();
    // press + clear → two audit rows; clear status === 'approved'.
    expect(records).toHaveLength(2);
    expect(records[0]?.kind).toBe('estop_press');
    expect(records[0]?.status).toBe('halted');
    expect(records[1]?.kind).toBe('estop_clear');
    expect(records[1]?.status).toBe('approved');
  });

  it('uses custom initiator when supplied', async () => {
    const path = join(tmp, 'audit.jsonl');
    const audit = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const e = new EStopLocal({ audit });
    await e.press({ reason: 'r', initiator: 'system' });
    await audit.close();

    const reader = await AuditLogReader.open(path);
    const records = [];
    for await (const r of reader.records()) records.push(r);
    await reader.close();
    expect(records[0]?.initiator).toBe('system');
  });

  it('press without audit or notifier still updates state', async () => {
    const e = new EStopLocal();
    await e.press({ reason: 'r' });
    expect(e.isPressed()).toBe(true);
  });

  it('clear without audit or notifier still updates state', async () => {
    const e = new EStopLocal();
    await e.press({ reason: 'r' });
    await e.clear({});
    expect(e.isPressed()).toBe(false);
  });
});
