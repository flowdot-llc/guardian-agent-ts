import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditLogWriter } from '../../src/audit/writer.js';
import { AuditLogReader } from '../../src/audit/reader.js';
import {
  EStopHub,
  InMemoryEStopStateStore,
  type EStopBroadcastChannel,
} from '../../src/estop/hub.js';
import type { Notifier } from '../../src/notify/types.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'guardian-hub-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function setupHub(opts: {
  notifier?: Notifier;
  broadcast?: EStopBroadcastChannel;
  recentAuthCheck?: (
    userId: string,
    options: { operatorId?: string },
  ) => Promise<boolean>;
  canonicalClearUrl?: string;
  cacheTtlMs?: number;
} = {}) {
  const path = join(tmp, 'audit.jsonl');
  const audit = new AuditLogWriter({ path, agentId: 'hub', sessionId: 'global' });
  const state = new InMemoryEStopStateStore();
  const hub = new EStopHub({ state, audit, ...opts });
  return { hub, audit, state, path };
}

async function readAll(path: string) {
  const r = await AuditLogReader.open(path);
  const records = [];
  for await (const rec of r.records()) records.push(rec);
  await r.close();
  return records;
}

describe('EStopHub.press / clear / status / isPressed', () => {
  it('starts not pressed for any user', async () => {
    const { hub } = await setupHub();
    expect(await hub.isPressed('u1')).toBe(false);
    expect((await hub.status('u1')).pressed).toBe(false);
  });

  it('press sets state, writes audit, fires notifier + broadcast', async () => {
    const broadcastFn = {
      broadcastPress: vi.fn(async () => undefined),
      broadcastClear: vi.fn(async () => undefined),
    } satisfies EStopBroadcastChannel;
    const notifyFn = vi.fn(async () => undefined);
    const notifier: Notifier = { notify: notifyFn };
    const { hub, audit, path } = await setupHub({
      broadcast: broadcastFn,
      notifier,
      canonicalClearUrl: 'https://example/clear',
    });

    const r = await hub.press('u1', { reason: 'manual', operatorId: 'op_x', detail: { ip: '1.2.3.4' } });
    await audit.close();
    expect(r.state.pressed).toBe(true);
    expect(r.state.pressedReason).toBe('manual');
    expect(broadcastFn.broadcastPress).toHaveBeenCalledOnce();
    expect(notifyFn).toHaveBeenCalledOnce();

    const records = await readAll(path);
    expect(records).toHaveLength(1);
    expect(records[0]?.kind).toBe('estop_press');
    expect(records[0]?.detail).toMatchObject({ user_id: 'u1', reason: 'manual', ip: '1.2.3.4' });

    // Notifier got the canonical clear URL.
    expect(notifyFn.mock.calls[0]?.[0]?.canonicalClearUrl).toBe('https://example/clear');
  });

  it('press is idempotent — already-pressed press does not re-broadcast or change pressedAt', async () => {
    const broadcastFn = {
      broadcastPress: vi.fn(async () => undefined),
      broadcastClear: vi.fn(async () => undefined),
    } satisfies EStopBroadcastChannel;
    const { hub, audit } = await setupHub({ broadcast: broadcastFn });

    await hub.press('u1', { reason: 'first' });
    const stateAfterFirst = await hub.status('u1');
    await hub.press('u1', { reason: 'second' });
    const stateAfterSecond = await hub.status('u1');
    await audit.close();

    expect(stateAfterSecond.pressedAt).toBe(stateAfterFirst.pressedAt);
    expect(stateAfterSecond.pressedReason).toBe('first');
    expect(broadcastFn.broadcastPress).toHaveBeenCalledOnce();
  });

  it('isPressed cache returns same value within TTL', async () => {
    const { hub, state } = await setupHub({ cacheTtlMs: 1000 });
    expect(await hub.isPressed('u1')).toBe(false);
    // Press directly via state — bypass cache invalidation.
    await state.set('u1', { pressed: true, pressedAt: 'x', pressedReason: 'r' });
    // Cache still says false until TTL expires or invalidate.
    expect(await hub.isPressed('u1')).toBe(false);
    hub.invalidateCache('u1');
    expect(await hub.isPressed('u1')).toBe(true);
  });

  it('isPressed cache expires after TTL', async () => {
    vi.useFakeTimers();
    try {
      const { hub, state } = await setupHub({ cacheTtlMs: 100 });
      expect(await hub.isPressed('u1')).toBe(false);
      await state.set('u1', { pressed: true, pressedAt: 'x' });
      vi.setSystemTime(Date.now() + 200);
      expect(await hub.isPressed('u1')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('invalidateAllCache clears every entry', async () => {
    const { hub, state } = await setupHub();
    await hub.isPressed('u1');
    await hub.isPressed('u2');
    await state.set('u1', { pressed: true, pressedAt: 'x' });
    await state.set('u2', { pressed: true, pressedAt: 'x' });
    hub.invalidateAllCache();
    expect(await hub.isPressed('u1')).toBe(true);
    expect(await hub.isPressed('u2')).toBe(true);
  });

  it('clear transitions state to cleared and broadcasts', async () => {
    const broadcastFn = {
      broadcastPress: vi.fn(async () => undefined),
      broadcastClear: vi.fn(async () => undefined),
    } satisfies EStopBroadcastChannel;
    const { hub, audit, path } = await setupHub({ broadcast: broadcastFn });
    await hub.press('u1', { reason: 'r' });
    const r = await hub.clear('u1', { operatorId: 'op' });
    await audit.close();
    expect(r.state.pressed).toBe(false);
    expect(r.state.clearedAt).toBeDefined();
    expect(broadcastFn.broadcastClear).toHaveBeenCalledOnce();
    const records = await readAll(path);
    expect(records.map((x) => x.kind)).toEqual(['estop_press', 'estop_clear']);
  });

  it('clear with minimal options does not record optional fields', async () => {
    const { hub, audit, path } = await setupHub();
    await hub.press('u1', { reason: 'r' });
    await hub.clear('u1', {});
    await audit.close();
    const records = await readAll(path);
    const clearRecord = records.find((r) => r.kind === 'estop_clear');
    expect(clearRecord?.detail).not.toHaveProperty('operator_id');
    expect(clearRecord?.detail).not.toHaveProperty('ip');
    expect(clearRecord?.detail).not.toHaveProperty('user_agent');
  });

  it('clear is no-op when not pressed', async () => {
    const { hub, audit, path } = await setupHub();
    const r = await hub.clear('u1', {});
    await audit.close();
    expect(r.state.pressed).toBe(false);

    // Audit may or may not exist (no append happened). Tolerate both.
    const { existsSync } = await import('node:fs');
    if (existsSync(path)) {
      expect((await readAll(path)).length).toBe(0);
    }
  });

  it('rejects agent-initiated clear (SPEC §7)', async () => {
    const { hub, audit } = await setupHub();
    await hub.press('u1', { reason: 'r' });
    const r = await hub.clear('u1', { initiator: 'agent', operatorId: 'op' });
    await audit.close();
    expect(r.state.pressed).toBe(true); // still pressed
    expect(r.authRequired).toBe(false);
  });

  it('agent-clear on never-touched user yields not-pressed state', async () => {
    const { hub, audit } = await setupHub();
    const r = await hub.clear('u_never', { initiator: 'agent' });
    await audit.close();
    expect(r.state.pressed).toBe(false);
    expect(r.authRequired).toBe(false);
  });

  it('recentAuthCheck-failed clear on never-touched user yields not-pressed state', async () => {
    const { hub, audit } = await setupHub({ recentAuthCheck: async () => false });
    const r = await hub.clear('u_never', {});
    await audit.close();
    expect(r.state.pressed).toBe(false);
    expect(r.authRequired).toBe(true);
  });

  it('press detail records merged user-supplied detail', async () => {
    const { hub, audit, path } = await setupHub();
    // No actor context: ip and userAgent absent.
    await hub.press('u1', { reason: 'r' });
    await audit.close();
    const records = await readAll(path);
    expect(records[0]?.detail).not.toHaveProperty('ip');
    expect(records[0]?.detail).not.toHaveProperty('user_agent');
  });

  it('returns authRequired when recentAuthCheck fails', async () => {
    const recentAuthCheck = vi.fn(async () => false);
    const { hub, audit } = await setupHub({ recentAuthCheck });
    await hub.press('u1', { reason: 'r' });
    const r = await hub.clear('u1', { operatorId: 'op' });
    await audit.close();
    expect(r.authRequired).toBe(true);
    expect(r.state.pressed).toBe(true);
    expect(recentAuthCheck).toHaveBeenCalledOnce();
  });

  it('clears when recentAuthCheck passes', async () => {
    const recentAuthCheck = vi.fn(async () => true);
    const { hub, audit } = await setupHub({ recentAuthCheck });
    await hub.press('u1', { reason: 'r' });
    const r = await hub.clear('u1', { operatorId: 'op' });
    await audit.close();
    expect(r.authRequired).toBeUndefined();
    expect(r.state.pressed).toBe(false);
  });

  it('per-user isolation: u1 press does not affect u2', async () => {
    const { hub } = await setupHub();
    await hub.press('u1', { reason: 'r' });
    expect(await hub.isPressed('u1')).toBe(true);
    expect(await hub.isPressed('u2')).toBe(false);
  });

  it('notifier event omits canonicalClearUrl when not configured', async () => {
    const notifyFn = vi.fn(async () => undefined);
    const { hub, audit } = await setupHub({ notifier: { notify: notifyFn } });
    await hub.press('u1', { reason: 'r' });
    await audit.close();
    const event = notifyFn.mock.calls[0]?.[0];
    expect(event?.canonicalClearUrl).toBeUndefined();
  });

  it('clear records actor context (source, ip, userAgent)', async () => {
    const { hub, audit, path } = await setupHub();
    await hub.press('u1', { reason: 'r' });
    await hub.clear(
      'u1',
      { operatorId: 'op' },
      { source: 'web', ip: '10.0.0.2', userAgent: 'Browser/2.0' },
    );
    await audit.close();
    const records = await readAll(path);
    const clear = records.find((r) => r.kind === 'estop_clear');
    expect(clear?.detail).toMatchObject({
      source: 'web',
      ip: '10.0.0.2',
      user_agent: 'Browser/2.0',
    });
  });

  it('press records actor context (source, ip, userAgent)', async () => {
    const { hub, audit, path } = await setupHub();
    await hub.press(
      'u1',
      { reason: 'r' },
      { source: 'mobile', ip: '10.0.0.1', userAgent: 'TestUA/1.0' },
    );
    await audit.close();
    const records = await readAll(path);
    expect(records[0]?.detail).toMatchObject({
      source: 'mobile',
      ip: '10.0.0.1',
      user_agent: 'TestUA/1.0',
    });
  });
});
