import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditLogWriter } from '../../src/audit/writer.js';
import { EStopHub, InMemoryEStopStateStore } from '../../src/estop/hub.js';
import {
  createEStopMiddleware,
  type MiddlewareRequest,
  type MiddlewareResponse,
} from '../../src/estop/middleware.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'guardian-mw-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function makeHub() {
  const path = join(tmp, 'audit.jsonl');
  const audit = new AuditLogWriter({ path, agentId: 'hub', sessionId: 'g' });
  const state = new InMemoryEStopStateStore();
  const hub = new EStopHub({ state, audit });
  return { hub, audit, state, path };
}

function fakeRes(): MiddlewareResponse & {
  body: string;
  headers: Record<string, string>;
} {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(this: MiddlewareResponse & { headers: Record<string, string> }, name: string, value: string) {
      this.headers[name] = value;
    },
    end(this: MiddlewareResponse & { body: string }, body?: string) {
      this.body = body ?? '';
    },
  } as MiddlewareResponse & { body: string; headers: Record<string, string> };
}

describe('createEStopMiddleware', () => {
  it('passes through when user not pressed', async () => {
    const { hub } = makeHub();
    const next = vi.fn();
    const mw = createEStopMiddleware(hub, { resolveUserId: () => 'u1' });
    const res = fakeRes();
    await mw({ headers: {} }, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(200);
  });

  it('passes through when resolveUserId returns null', async () => {
    const { hub } = makeHub();
    const next = vi.fn();
    const mw = createEStopMiddleware(hub, { resolveUserId: () => null });
    const res = fakeRes();
    await mw({ headers: {} }, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('returns 423 with JSON body when user pressed', async () => {
    const { hub, audit } = makeHub();
    await hub.press('u1', { reason: 'manual' });
    await audit.close();
    const next = vi.fn();
    const mw = createEStopMiddleware(hub, { resolveUserId: () => 'u1' });
    const res = fakeRes();
    await mw({ headers: {} }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(423);
    expect(res.headers['content-type']).toBe('application/json');
    const parsed = JSON.parse(res.body);
    expect(parsed.error).toBe('estop_active');
    expect(parsed.pressed_at).toBeDefined();
  });

  it('bypasses when exclude predicate returns true', async () => {
    const { hub, audit } = makeHub();
    await hub.press('u1', { reason: 'r' });
    await audit.close();
    const next = vi.fn();
    const mw = createEStopMiddleware(hub, {
      resolveUserId: () => 'u1',
      exclude: (req) => req.url === '/estop/clear',
    });
    const res = fakeRes();
    await mw({ headers: {}, url: '/estop/clear' }, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('honors lockedResponseBody override', async () => {
    const { hub, audit } = makeHub();
    await hub.press('u1', { reason: 'r' });
    await audit.close();
    const mw = createEStopMiddleware(hub, {
      resolveUserId: () => 'u1',
      lockedResponseBody: (state, userId) => ({ custom: true, user: userId, at: state.pressedAt }),
    });
    const res = fakeRes();
    await mw({ headers: {} }, res, vi.fn());
    const parsed = JSON.parse(res.body);
    expect(parsed.custom).toBe(true);
    expect(parsed.user).toBe('u1');
    expect(parsed.at).toBeDefined();
  });
});
