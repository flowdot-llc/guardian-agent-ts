import { describe, expect, it, vi } from 'vitest';

import {
  dataChannelGate,
  decodeResponse,
  encodeRequest,
} from '../../src/gate/data-channel.js';
import type { GateRequest } from '../../src/gate/types.js';

function req(o: Partial<GateRequest> = {}): GateRequest {
  return {
    event_id: 'evt_42',
    tool_name: 'tool.x',
    tool_args: { a: 1 },
    agent_id: 'a',
    session_id: 's',
    granularity: 'tool',
    ...o,
  };
}

const decoder = new TextDecoder();

describe('encodeRequest / decodeResponse', () => {
  it('encodes a request to a tool_permission_request frame', () => {
    const buf = encodeRequest(req({ model: { provider: 'p', id: 'm' }, context: 'hi' }));
    const obj = JSON.parse(decoder.decode(buf));
    expect(obj.kind).toBe('tool_permission_request');
    expect(obj.requestId).toBe('evt_42');
    expect(obj.toolName).toBe('tool.x');
    expect(obj.model.provider).toBe('p');
    expect(obj.context).toBe('hi');
    expect(obj.granularity).toBe('tool');
  });

  it('omits model / context when not supplied', () => {
    const buf = encodeRequest(req());
    const obj = JSON.parse(decoder.decode(buf));
    expect(obj.model).toBeUndefined();
    expect(obj.context).toBeUndefined();
  });

  it('encodes per-request timeout when present', () => {
    const buf = encodeRequest(req({ timeout_ms: 1234 }));
    const obj = JSON.parse(decoder.decode(buf));
    expect(obj.timeoutMs).toBe(1234);
  });

  it('decodes a valid response frame', () => {
    const frame = new TextEncoder().encode(
      JSON.stringify({
        kind: 'tool_permission_response',
        requestId: 'evt_42',
        decision: 'allow',
        granularity: 'tool',
        operatorId: 'op',
      }),
    );
    const out = decodeResponse(frame);
    expect(out).not.toBeNull();
    expect(out!.requestId).toBe('evt_42');
    expect(out!.response.decision).toBe('allow');
    expect(out!.response.operator_id).toBe('op');
  });

  it('returns null on malformed JSON', () => {
    expect(decodeResponse(new TextEncoder().encode('not json'))).toBeNull();
  });

  it('returns null on wrong kind', () => {
    const f = new TextEncoder().encode(JSON.stringify({ kind: 'other' }));
    expect(decodeResponse(f)).toBeNull();
  });

  it('returns null when requestId missing', () => {
    const f = new TextEncoder().encode(
      JSON.stringify({ kind: 'tool_permission_response', decision: 'allow', granularity: 'tool' }),
    );
    expect(decodeResponse(f)).toBeNull();
  });

  it('returns null on bad decision', () => {
    const f = new TextEncoder().encode(
      JSON.stringify({
        kind: 'tool_permission_response',
        requestId: 'evt_42',
        decision: 'maybe',
        granularity: 'tool',
      }),
    );
    expect(decodeResponse(f)).toBeNull();
  });

  it('returns null on bad granularity', () => {
    const f = new TextEncoder().encode(
      JSON.stringify({
        kind: 'tool_permission_response',
        requestId: 'evt_42',
        decision: 'allow',
        granularity: 'planet',
      }),
    );
    expect(decodeResponse(f)).toBeNull();
  });

  it('returns null on non-object root', () => {
    const f = new TextEncoder().encode(JSON.stringify('hi'));
    expect(decodeResponse(f)).toBeNull();
  });

  it('returns null on bad reason type', () => {
    const f = new TextEncoder().encode(
      JSON.stringify({
        kind: 'tool_permission_response',
        requestId: 'evt_42',
        decision: 'allow',
        granularity: 'tool',
        reason: 7,
      }),
    );
    expect(decodeResponse(f)).toBeNull();
  });

  it('returns null on bad operatorId type', () => {
    const f = new TextEncoder().encode(
      JSON.stringify({
        kind: 'tool_permission_response',
        requestId: 'evt_42',
        decision: 'allow',
        granularity: 'tool',
        operatorId: 7,
      }),
    );
    expect(decodeResponse(f)).toBeNull();
  });

  it('omits operator_id when not present', () => {
    const f = new TextEncoder().encode(
      JSON.stringify({
        kind: 'tool_permission_response',
        requestId: 'evt_42',
        decision: 'allow',
        granularity: 'tool',
      }),
    );
    const out = decodeResponse(f);
    expect(out!.response.operator_id).toBeUndefined();
  });

  it('preserves reason when valid', () => {
    const f = new TextEncoder().encode(
      JSON.stringify({
        kind: 'tool_permission_response',
        requestId: 'evt_42',
        decision: 'deny',
        granularity: 'tool',
        reason: 'too dangerous',
      }),
    );
    expect(decodeResponse(f)!.response.reason).toBe('too dangerous');
  });
});

describe('dataChannelGate', () => {
  it('resolves the request when a matching response arrives', async () => {
    let registered: ((frame: Uint8Array) => void) | null = null;
    const send = vi.fn();
    const gate = dataChannelGate({
      send,
      onResponse: (handler) => {
        registered = handler;
        return () => undefined;
      },
    });

    const promise = gate(req());
    // Simulate the worker echoing back a response.
    expect(registered).not.toBeNull();
    registered!(
      new TextEncoder().encode(
        JSON.stringify({
          kind: 'tool_permission_response',
          requestId: 'evt_42',
          decision: 'allow_session',
          granularity: 'tool',
        }),
      ),
    );
    const r = await promise;
    expect(r.decision).toBe('allow_session');
    expect(send).toHaveBeenCalledOnce();
  });

  it('ignores response frames for unknown requestIds', async () => {
    let registered: ((frame: Uint8Array) => void) | null = null;
    const gate = dataChannelGate({
      send: () => undefined,
      onResponse: (handler) => {
        registered = handler;
        return () => undefined;
      },
      timeoutMs: 50,
    });

    const promise = gate(req());
    // Frame for a different request.
    registered!(
      new TextEncoder().encode(
        JSON.stringify({
          kind: 'tool_permission_response',
          requestId: 'evt_other',
          decision: 'allow',
          granularity: 'tool',
        }),
      ),
    );
    const r = await promise;
    expect(r.reason).toBe('gate_timeout');
  });

  it('ignores malformed response frames', async () => {
    let registered: ((frame: Uint8Array) => void) | null = null;
    const gate = dataChannelGate({
      send: () => undefined,
      onResponse: (handler) => {
        registered = handler;
        return () => undefined;
      },
      timeoutMs: 30,
    });

    const promise = gate(req());
    registered!(new TextEncoder().encode('garbage'));
    const r = await promise;
    expect(r.reason).toBe('gate_timeout');
  });

  it('times out per the default option', async () => {
    const gate = dataChannelGate({
      send: () => undefined,
      onResponse: () => () => undefined,
      timeoutMs: 5,
    });
    const r = await gate(req());
    expect(r.decision).toBe('deny');
    expect(r.reason).toBe('gate_timeout');
  });

  it('uses per-request timeout when supplied', async () => {
    const gate = dataChannelGate({
      send: () => undefined,
      onResponse: () => () => undefined,
    });
    const r = await gate(req({ timeout_ms: 5 }));
    expect(r.reason).toBe('gate_timeout');
  });

  it('returns deny on send error', async () => {
    const gate = dataChannelGate({
      send: () => {
        throw new Error('channel closed');
      },
      onResponse: () => () => undefined,
      timeoutMs: 1000,
    });
    const r = await gate(req());
    expect(r.reason).toContain('data_channel_send_error:channel closed');
  });

  it('returns deny on async send rejection', async () => {
    const gate = dataChannelGate({
      send: async () => {
        throw new Error('async send failed');
      },
      onResponse: () => () => undefined,
      timeoutMs: 1000,
    });
    const r = await gate(req());
    expect(r.reason).toContain('async send failed');
  });

  it('stringifies non-Error send rejections', async () => {
    const gate = dataChannelGate({
      send: async () => {
        throw 'plain string';
      },
      onResponse: () => () => undefined,
      timeoutMs: 1000,
    });
    const r = await gate(req());
    expect(r.reason).toContain('plain string');
  });

  it('exposes a dispose method that calls the unsubscribe', () => {
    const unsubscribe = vi.fn();
    const gate = dataChannelGate({
      send: () => undefined,
      onResponse: () => unsubscribe,
    });
    (gate as unknown as { dispose: () => void }).dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
