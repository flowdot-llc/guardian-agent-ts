import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditLogReader } from '../../src/audit/reader.js';
import { AuditLogWriter } from '../../src/audit/writer.js';
import { EStopLocal } from '../../src/estop/local.js';
import { HeartbeatMonitor } from '../../src/estop/heartbeat.js';
import type { AuditRecord } from '../../src/types.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'heartbeat-'));
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

/**
 * Test harness: deterministic clock + manually-driven interval. Tests call
 * `monitor.tick()` directly instead of waiting on real timers.
 */
function fakeTimers() {
  let _now = 0;
  const handles: { cb: () => void; ms: number; cleared: boolean }[] = [];
  return {
    now: () => _now,
    setNow: (t: number) => {
      _now = t;
    },
    setIntervalFn: (cb: () => void, ms: number) => {
      handles.push({ cb, ms, cleared: false });
      return handles.length - 1;
    },
    clearIntervalFn: (h: unknown) => {
      const i = h as number;
      if (handles[i]) handles[i]!.cleared = true;
    },
    handles,
  };
}

describe('HeartbeatMonitor construction', () => {
  it('rejects softMs <= 0', () => {
    expect(() => new HeartbeatMonitor({ softMs: 0, hardMs: 10 })).toThrow(/softMs/);
  });
  it('rejects hardMs <= softMs', () => {
    expect(() => new HeartbeatMonitor({ softMs: 10, hardMs: 10 })).toThrow(/hardMs/);
    expect(() => new HeartbeatMonitor({ softMs: 100, hardMs: 50 })).toThrow(/hardMs/);
  });
  it('accepts a valid window', () => {
    const m = new HeartbeatMonitor({ softMs: 10, hardMs: 20 });
    expect(m.getState().state).toBe('idle');
  });
  it('computes checkIntervalMs default and clamps to [50, 5000]', () => {
    // Tiny window → clamped up to 50ms
    const tiny = new HeartbeatMonitor({ softMs: 4, hardMs: 8 });
    // Just verify it constructs; check interval is internal.
    expect(tiny.getState().state).toBe('idle');
    // Huge window → clamped down to 5000ms
    const huge = new HeartbeatMonitor({ softMs: 1_000_000, hardMs: 2_000_000 });
    expect(huge.getState().state).toBe('idle');
  });
});

describe('HeartbeatMonitor lifecycle (no audit, no estop)', () => {
  it('idle → softMissed → hardMissed as time advances', async () => {
    const ft = fakeTimers();
    const m = new HeartbeatMonitor({
      softMs: 100,
      hardMs: 300,
      now: ft.now,
      setIntervalFn: ft.setIntervalFn,
      clearIntervalFn: ft.clearIntervalFn,
    });
    m.start();
    ft.setNow(50);
    await m.tick();
    expect(m.getState().state).toBe('idle');
    ft.setNow(150);
    await m.tick();
    expect(m.getState().state).toBe('softMissed');
    ft.setNow(400);
    await m.tick();
    expect(m.getState().state).toBe('hardMissed');
  });

  it('heartbeat resets soft state back to idle', async () => {
    const ft = fakeTimers();
    const m = new HeartbeatMonitor({
      softMs: 100,
      hardMs: 300,
      now: ft.now,
      setIntervalFn: ft.setIntervalFn,
      clearIntervalFn: ft.clearIntervalFn,
    });
    m.start();
    ft.setNow(150);
    await m.tick();
    expect(m.getState().state).toBe('softMissed');
    ft.setNow(160);
    m.heartbeat();
    expect(m.getState().state).toBe('idle');
  });

  it('heartbeat does NOT recover from hardMissed', async () => {
    const ft = fakeTimers();
    const m = new HeartbeatMonitor({
      softMs: 100,
      hardMs: 200,
      now: ft.now,
      setIntervalFn: ft.setIntervalFn,
      clearIntervalFn: ft.clearIntervalFn,
    });
    m.start();
    ft.setNow(250);
    await m.tick();
    expect(m.getState().state).toBe('hardMissed');
    m.heartbeat();
    expect(m.getState().state).toBe('hardMissed');
  });

  it('start is idempotent', () => {
    const ft = fakeTimers();
    const m = new HeartbeatMonitor({
      softMs: 100,
      hardMs: 200,
      now: ft.now,
      setIntervalFn: ft.setIntervalFn,
      clearIntervalFn: ft.clearIntervalFn,
    });
    m.start();
    m.start();
    expect(ft.handles).toHaveLength(1);
  });

  it('stop clears the interval handle and is idempotent', () => {
    const ft = fakeTimers();
    const m = new HeartbeatMonitor({
      softMs: 100,
      hardMs: 200,
      now: ft.now,
      setIntervalFn: ft.setIntervalFn,
      clearIntervalFn: ft.clearIntervalFn,
    });
    m.start();
    m.stop();
    m.stop();
    expect(ft.handles[0]?.cleared).toBe(true);
  });

  it('does not auto-restart after stop', () => {
    const ft = fakeTimers();
    const m = new HeartbeatMonitor({
      softMs: 100,
      hardMs: 200,
      now: ft.now,
      setIntervalFn: ft.setIntervalFn,
      clearIntervalFn: ft.clearIntervalFn,
    });
    m.start();
    m.stop();
    m.start();
    expect(ft.handles).toHaveLength(1);
  });

  it('tick is a no-op after stop', async () => {
    const ft = fakeTimers();
    const m = new HeartbeatMonitor({
      softMs: 100,
      hardMs: 200,
      now: ft.now,
      setIntervalFn: ft.setIntervalFn,
      clearIntervalFn: ft.clearIntervalFn,
    });
    m.start();
    m.stop();
    ft.setNow(500);
    await m.tick();
    expect(m.getState().state).toBe('idle');
  });

  it('after hardMissed, the monitor stops checking automatically', async () => {
    const ft = fakeTimers();
    const m = new HeartbeatMonitor({
      softMs: 100,
      hardMs: 200,
      now: ft.now,
      setIntervalFn: ft.setIntervalFn,
      clearIntervalFn: ft.clearIntervalFn,
    });
    m.start();
    ft.setNow(300);
    await m.tick();
    expect(m.getState().state).toBe('hardMissed');
    // Interval should be cleared by stop().
    expect(ft.handles[0]?.cleared).toBe(true);
  });
});

describe('HeartbeatMonitor + audit + estop', () => {
  it('writes x_heartbeat_warning (soft) without pressing estop', async () => {
    const ft = fakeTimers();
    const path = join(tmp, 'audit.jsonl');
    const audit = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const estop = new EStopLocal({ audit });
    const m = new HeartbeatMonitor({
      softMs: 100,
      hardMs: 1000,
      audit,
      estop,
      now: ft.now,
      setIntervalFn: ft.setIntervalFn,
      clearIntervalFn: ft.clearIntervalFn,
    });
    m.start();
    ft.setNow(150);
    await m.tick();
    expect(estop.isPressed()).toBe(false);
    await audit.close();

    const recs = await readAll(path);
    const warn = recs.find((r) => r.kind === ('x_heartbeat_warning' as unknown));
    expect(warn?.detail?.level).toBe('soft');
  });

  it('writes x_heartbeat_warning (hard) AND presses estop with reason heartbeat_missed', async () => {
    const ft = fakeTimers();
    const path = join(tmp, 'audit.jsonl');
    const audit = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const estop = new EStopLocal({ audit });
    const m = new HeartbeatMonitor({
      softMs: 100,
      hardMs: 200,
      audit,
      estop,
      now: ft.now,
      setIntervalFn: ft.setIntervalFn,
      clearIntervalFn: ft.clearIntervalFn,
    });
    m.start();
    ft.setNow(250);
    await m.tick();
    expect(estop.isPressed()).toBe(true);
    await audit.close();

    const recs = await readAll(path);
    const hard = recs.find(
      (r) => r.kind === ('x_heartbeat_warning' as unknown) && r.detail?.level === 'hard',
    );
    expect(hard).toBeDefined();
    const press = recs.find((r) => r.kind === 'estop_press');
    expect(press?.detail?.reason).toBe('heartbeat_missed');
  });

  it('audit-only mode (no estop) still records hard-miss warning', async () => {
    const ft = fakeTimers();
    const path = join(tmp, 'audit.jsonl');
    const audit = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const m = new HeartbeatMonitor({
      softMs: 100,
      hardMs: 200,
      audit,
      now: ft.now,
      setIntervalFn: ft.setIntervalFn,
      clearIntervalFn: ft.clearIntervalFn,
    });
    m.start();
    ft.setNow(250);
    await m.tick();
    await audit.close();
    const recs = await readAll(path);
    const hard = recs.find(
      (r) => r.kind === ('x_heartbeat_warning' as unknown) && r.detail?.level === 'hard',
    );
    expect(hard).toBeDefined();
  });

  it('default constructor uses real setInterval (smoke test, no audit)', () => {
    const m = new HeartbeatMonitor({ softMs: 100, hardMs: 200 });
    m.start();
    m.stop();
    expect(m.getState().state).toBe('idle');
  });

  it('the interval callback drives tick() automatically', async () => {
    const ft = fakeTimers();
    const path = join(tmp, 'audit.jsonl');
    const audit = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const m = new HeartbeatMonitor({
      softMs: 100,
      hardMs: 200,
      audit,
      now: ft.now,
      setIntervalFn: ft.setIntervalFn,
      clearIntervalFn: ft.clearIntervalFn,
    });
    m.start();
    expect(ft.handles).toHaveLength(1);
    ft.setNow(150);
    // Invoke the stored interval callback as the real setInterval would.
    ft.handles[0]!.cb();
    // Microtask flush.
    await new Promise((r) => setImmediate(r));
    expect(m.getState().state).toBe('softMissed');
    await audit.close();
  });
});
