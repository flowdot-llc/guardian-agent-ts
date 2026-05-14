import { afterEach, describe, expect, it, vi } from 'vitest';

import { asyncCallbackGate } from '../../src/gate/async-callback.js';
import type { GateRequest, GateResponse } from '../../src/gate/types.js';

function req(o: Partial<GateRequest> = {}): GateRequest {
  return {
    event_id: 'evt_x',
    tool_name: 'tool.x',
    tool_args: {},
    agent_id: 'a',
    session_id: 's',
    granularity: 'tool',
    ...o,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('asyncCallbackGate', () => {
  it('falls back to global fetch and default timeout when not configured', async () => {
    const stub = vi.fn(async () =>
      new Response(JSON.stringify({ decision: 'allow', granularity: 'tool' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', stub);
    const gate = asyncCallbackGate({ url: 'https://example/gate' });
    const r = await gate(req());
    expect(r.decision).toBe('allow');
    expect(stub).toHaveBeenCalledOnce();
  });

  it('POSTs the request and returns the response on 200', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ decision: 'allow', granularity: 'tool', operator_id: 'op' }),
    );
    const gate = asyncCallbackGate({ url: 'https://example/gate', fetch: fetchMock });
    const r = await gate(req());
    expect(r.decision).toBe('allow');
    expect(r.operator_id).toBe('op');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(init.body).toContain('"tool_name":"tool.x"');
  });

  it('returns deny with status reason on non-2xx', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 503 }));
    const gate = asyncCallbackGate({ url: 'https://example/gate', fetch: fetchMock });
    const r = await gate(req());
    expect(r.decision).toBe('deny');
    expect(r.reason).toBe('callback_status_503');
  });

  it('returns deny with invalid_response reason on bad shape', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ decision: 'maybe' }));
    const gate = asyncCallbackGate({ url: 'https://example/gate', fetch: fetchMock });
    const r = await gate(req());
    expect(r.decision).toBe('deny');
    expect(r.reason).toBe('callback_invalid_response');
  });

  it('returns deny on network error', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network unreachable');
    });
    const gate = asyncCallbackGate({ url: 'https://example/gate', fetch: fetchMock });
    const r = await gate(req());
    expect(r.decision).toBe('deny');
    expect(r.reason).toContain('callback_error:network unreachable');
  });

  it('returns deny gate_timeout on abort', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      // Simulate the abort propagating.
      const err = new Error('aborted');
      err.name = 'AbortError';
      // Use the signal so the abort path is taken.
      if (init?.signal?.aborted === false) {
        await new Promise<void>((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(err));
        });
      }
      throw err;
    });
    const gate = asyncCallbackGate({
      url: 'https://example/gate',
      fetch: fetchMock,
      timeoutMs: 5,
    });
    const r = await gate(req());
    expect(r.decision).toBe('deny');
    expect(r.reason).toBe('gate_timeout');
  });

  it('honors per-request timeout_ms override', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      if (init?.signal?.aborted === false) {
        await new Promise<void>((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(err));
        });
      }
      throw err;
    });
    const gate = asyncCallbackGate({ url: 'https://example/gate', fetch: fetchMock });
    const r = await gate(req({ timeout_ms: 5 }));
    expect(r.reason).toBe('gate_timeout');
  });

  it('sends additional headers', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ decision: 'allow', granularity: 'tool' }),
    );
    const gate = asyncCallbackGate({
      url: 'https://example/gate',
      fetch: fetchMock,
      headers: { authorization: 'Bearer x' },
    });
    await gate(req());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer x');
  });

  it('handles non-Error throws by stringifying', async () => {
    const fetchMock = vi.fn(async () => {
      throw 'just a string';
    });
    const gate = asyncCallbackGate({ url: 'https://example/gate', fetch: fetchMock });
    const r = await gate(req());
    expect(r.reason).toContain('just a string');
  });

  it('accepts every valid decision value', async () => {
    const decisions: GateResponse['decision'][] = [
      'allow',
      'allow_session',
      'allow_forever',
      'deny',
      'ban_forever',
    ];
    for (const d of decisions) {
      const fetchMock = vi.fn(async () =>
        jsonResponse({ decision: d, granularity: 'tool' }),
      );
      const gate = asyncCallbackGate({ url: 'https://example/gate', fetch: fetchMock });
      const r = await gate(req());
      expect(r.decision).toBe(d);
    }
  });

  it('rejects response with bad reason type', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ decision: 'allow', granularity: 'tool', reason: 7 }),
    );
    const gate = asyncCallbackGate({ url: 'https://example/gate', fetch: fetchMock });
    const r = await gate(req());
    expect(r.reason).toBe('callback_invalid_response');
  });

  it('rejects response with bad operator_id type', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ decision: 'allow', granularity: 'tool', operator_id: 7 }),
    );
    const gate = asyncCallbackGate({ url: 'https://example/gate', fetch: fetchMock });
    const r = await gate(req());
    expect(r.reason).toBe('callback_invalid_response');
  });

  it('rejects response with bad granularity', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ decision: 'allow', granularity: 'planet' }),
    );
    const gate = asyncCallbackGate({ url: 'https://example/gate', fetch: fetchMock });
    const r = await gate(req());
    expect(r.reason).toBe('callback_invalid_response');
  });

  it('rejects non-object response', async () => {
    const fetchMock = vi.fn(async () => jsonResponse('hi'));
    const gate = asyncCallbackGate({ url: 'https://example/gate', fetch: fetchMock });
    const r = await gate(req());
    expect(r.reason).toBe('callback_invalid_response');
  });
});
