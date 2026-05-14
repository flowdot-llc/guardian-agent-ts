import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditLogReader } from '../../src/audit/reader.js';
import { AuditLogWriter } from '../../src/audit/writer.js';
import { GuardianRuntime } from '../../src/runtime/runtime.js';
import {
  CapabilityWindow,
  type CapabilityRule,
} from '../../src/runtime/capability.js';
import type { AuditRecord } from '../../src/types.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'capability-'));
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

describe('CapabilityWindow', () => {
  it('rejects rules with empty combination', () => {
    expect(
      () =>
        new CapabilityWindow({
          rules: [{ id: 'bad', combination: [], window_ms: 1000, level: 'yellow' }],
        }),
    ).toThrow(/empty combination/);
  });

  it('rejects rules with non-positive window_ms', () => {
    expect(
      () =>
        new CapabilityWindow({
          rules: [{ id: 'bad', combination: ['read'], window_ms: 0, level: 'yellow' }],
        }),
    ).toThrow(/window_ms/);
  });

  it('fires a rule when combination is observed within window', () => {
    let now = 0;
    const w = new CapabilityWindow({
      rules: [
        {
          id: 'exfil',
          combination: ['credential', 'network-egress', 'write'],
          window_ms: 60_000,
          level: 'yellow',
        },
      ],
      now: () => now,
    });
    now = 1000;
    expect(w.record(['credential'], 'evt-1')).toHaveLength(0);
    now = 2000;
    expect(w.record(['network-egress'], 'evt-2')).toHaveLength(0);
    now = 3000;
    const matches = w.record(['write'], 'evt-3');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.ruleId).toBe('exfil');
    expect(matches[0]?.contributingEventIds).toEqual(['evt-1', 'evt-2', 'evt-3']);
  });

  it('does not fire when combination spans MORE than the window', () => {
    let now = 0;
    const w = new CapabilityWindow({
      rules: [
        {
          id: 'exfil',
          combination: ['credential', 'network-egress', 'write'],
          window_ms: 60_000,
          level: 'yellow',
        },
      ],
      now: () => now,
    });
    now = 1000;
    w.record(['credential'], 'evt-1');
    now = 70_000; // 69s later — outside the 60s window
    w.record(['network-egress'], 'evt-2');
    now = 71_000;
    const matches = w.record(['write'], 'evt-3');
    expect(matches).toHaveLength(0);
  });

  it('drops events older than the longest rule window', () => {
    let now = 0;
    const w = new CapabilityWindow({
      rules: [{ id: 'r', combination: ['read', 'write'], window_ms: 1000, level: 'yellow' }],
      now: () => now,
    });
    now = 1;
    w.record(['read'], 'a');
    now = 2;
    w.record(['write'], 'b');
    expect(w.buffered()).toHaveLength(2);
    now = 100_000;
    w.record(['read'], 'c');
    // Events a & b should be aged out (window=1000).
    expect(w.buffered().map((e) => e.eventId)).toEqual(['c']);
  });

  it('honors maxEvents hard cap', () => {
    let now = 0;
    const w = new CapabilityWindow({
      rules: [{ id: 'r', combination: ['read'], window_ms: 1_000_000_000, level: 'yellow' }],
      now: () => now,
      maxEvents: 3,
    });
    for (let i = 0; i < 5; i++) {
      now = i + 1;
      w.record(['read'], 'e' + i);
    }
    expect(w.buffered()).toHaveLength(3);
    expect(w.buffered().map((e) => e.eventId)).toEqual(['e2', 'e3', 'e4']);
  });

  it('returns contributing events in chronological order', () => {
    let now = 0;
    const w = new CapabilityWindow({
      rules: [
        {
          id: 'r',
          combination: ['credential', 'network-egress', 'write'],
          window_ms: 60_000,
          level: 'yellow',
        },
      ],
      now: () => now,
    });
    now = 100;
    w.record(['write'], 'late');
    now = 50;
    w.record(['credential'], 'early');
    now = 75;
    const matches = w.record(['network-egress'], 'mid');
    // The match scans from newest to oldest; contributors are sorted chrono.
    expect(matches[0]?.contributingEventIds).toEqual(['early', 'mid', 'late']);
  });

  it('per-rule cutoff: a short-window rule ignores events that are still buffered for a longer-window rule', () => {
    let now = 0;
    const w = new CapabilityWindow({
      rules: [
        { id: 'short', combination: ['read', 'write'], window_ms: 100, level: 'yellow' },
        { id: 'long', combination: ['read', 'write'], window_ms: 100_000, level: 'yellow' },
      ],
      now: () => now,
    });
    now = 1;
    w.record(['read'], 'old-read');
    now = 200; // outside the 100ms short window, inside the 100_000ms long window
    const matches = w.record(['write'], 'fresh-write');
    const ids = matches.map((m) => m.ruleId).sort();
    // The short rule should NOT fire (old-read is past its cutoff).
    // The long rule SHOULD fire.
    expect(ids).toEqual(['long']);
  });

  it('multiple rules can fire on one event', () => {
    let now = 0;
    const rules: CapabilityRule[] = [
      { id: 'r1', combination: ['read', 'write'], window_ms: 10_000, level: 'yellow' },
      { id: 'r2', combination: ['write'], window_ms: 10_000, level: 'yellow' },
    ];
    const w = new CapabilityWindow({ rules, now: () => now });
    now = 1;
    w.record(['read'], 'a');
    now = 2;
    const matches = w.record(['write'], 'b');
    const ids = matches.map((m) => m.ruleId).sort();
    expect(ids).toEqual(['r1', 'r2']);
  });

  it('single-class rule fires on its own event', () => {
    let now = 0;
    const w = new CapabilityWindow({
      rules: [{ id: 'cred', combination: ['credential'], window_ms: 10_000, level: 'yellow' }],
      now: () => now,
    });
    now = 5;
    const matches = w.record(['credential'], 'a');
    expect(matches).toHaveLength(1);
  });

  it('tool that exercises multiple classes can satisfy the rule alone', () => {
    let now = 0;
    const w = new CapabilityWindow({
      rules: [
        {
          id: 'r',
          combination: ['credential', 'network-egress'],
          window_ms: 10_000,
          level: 'yellow',
        },
      ],
      now: () => now,
    });
    now = 1;
    const matches = w.record(['credential', 'network-egress'], 'a');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.contributingEventIds).toEqual(['a']);
  });

  it('classes not in any rule are still recorded (window accounting)', () => {
    const w = new CapabilityWindow({
      rules: [{ id: 'r', combination: ['credential'], window_ms: 1000, level: 'yellow' }],
    });
    w.record(['unknown'], 'a');
    expect(w.buffered()).toHaveLength(1);
  });

  it('no rules → no firing, but events still buffered', () => {
    // An empty rule list yields maxWindowMs=0 → no age prune. We still
    // cap by maxEvents.
    const w = new CapabilityWindow({ rules: [], maxEvents: 2 });
    w.record(['read'], 'a');
    w.record(['read'], 'b');
    w.record(['read'], 'c');
    expect(w.buffered()).toHaveLength(2);
    expect(w.buffered().map((e) => e.eventId)).toEqual(['b', 'c']);
  });
});

describe('GuardianRuntime + capability rules', () => {
  it('fires x_capability_yellow when combination observed within window', async () => {
    const path = join(tmp, 'audit.jsonl');
    const audit = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const rt = new GuardianRuntime({
      agentId: 'a',
      sessionId: 's',
      audit,
      capabilityRules: [
        {
          id: 'exfil',
          combination: ['credential', 'network-egress', 'write'],
          window_ms: 60_000,
          level: 'yellow',
        },
      ],
    });

    const readCred = rt.tool(async () => 'cred', {
      name: 'read_credentials',
      capabilities: ['credential'],
    });
    const fetchExternal = rt.tool(async () => 'ok', {
      name: 'fetch_external',
      capabilities: ['network-egress'],
    });
    const writeLocal = rt.tool(async () => 'ok', {
      name: 'write_local',
      capabilities: ['write'],
    });

    await readCred();
    await fetchExternal();
    await writeLocal();
    await rt.close();

    const recs = await readAll(path);
    const yellow = recs.find((r) => r.kind === ('x_capability_yellow' as unknown));
    expect(yellow).toBeDefined();
    expect(yellow?.detail?.rule_id).toBe('exfil');
    expect((yellow?.detail?.contributing_event_ids as string[])?.length).toBe(3);
  });

  it('Yellow event does NOT change dispatch behavior — tool still executes', async () => {
    const path = join(tmp, 'audit.jsonl');
    const audit = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const rt = new GuardianRuntime({
      agentId: 'a',
      sessionId: 's',
      audit,
      capabilityRules: [
        { id: 'r', combination: ['read'], window_ms: 10_000, level: 'yellow' },
      ],
    });
    const t = rt.tool(async () => 'returned-result', {
      name: 'read_file',
      capabilities: ['read'],
    });
    const result = await t();
    await rt.close();
    expect(result).toBe('returned-result');
  });

  it('untagged tools record as "unknown" and do not trigger consumer rules', async () => {
    const path = join(tmp, 'audit.jsonl');
    const audit = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const rt = new GuardianRuntime({
      agentId: 'a',
      sessionId: 's',
      audit,
      capabilityRules: [
        { id: 'r', combination: ['read'], window_ms: 10_000, level: 'yellow' },
      ],
    });
    const t = rt.tool(async () => 'ok', { name: 'untagged' });
    await t();
    await rt.close();
    const recs = await readAll(path);
    expect(recs.some((r) => r.kind === ('x_capability_yellow' as unknown))).toBe(false);
  });

  it('no capabilityRules supplied → no capability events fire ever', async () => {
    const path = join(tmp, 'audit.jsonl');
    const audit = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const rt = new GuardianRuntime({ agentId: 'a', sessionId: 's', audit });
    const t = rt.tool(async () => 'ok', {
      name: 'read_credentials',
      capabilities: ['credential', 'network-egress', 'write'],
    });
    await t();
    await rt.close();
    const recs = await readAll(path);
    expect(recs.some((r) => r.kind === ('x_capability_yellow' as unknown))).toBe(false);
    expect(recs.some((r) => r.kind === ('x_capability_redline' as unknown))).toBe(false);
  });

  it('Red-line level emits x_capability_redline audit kind (no auto-stop in v0.8)', async () => {
    const path = join(tmp, 'audit.jsonl');
    const audit = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const rt = new GuardianRuntime({
      agentId: 'a',
      sessionId: 's',
      audit,
      capabilityRules: [
        { id: 'r', combination: ['credential'], window_ms: 10_000, level: 'red' },
      ],
    });
    const t = rt.tool(async () => 'ran', {
      name: 'creds',
      capabilities: ['credential'],
    });
    // In v0.8 Red-line is audit-only too; dispatch should succeed.
    const result = await t();
    expect(result).toBe('ran');
    await rt.close();
    const recs = await readAll(path);
    expect(recs.some((r) => r.kind === ('x_capability_redline' as unknown))).toBe(true);
  });
});
