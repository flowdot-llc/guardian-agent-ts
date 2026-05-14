import { describe, expect, it, vi } from 'vitest';

import { createEStopPoller } from '../../src/estop/poller.js';
import type { EStopState } from '../../src/estop/types.js';

function stateResponse(state: EStopState): Response {
  return new Response(JSON.stringify(state), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('EStopPoller', () => {
  it('fires onPress on false → true transition', async () => {
    let pressed = false;
    const fetchMock = vi.fn(async () => stateResponse({ pressed }));
    const onPress = vi.fn();
    const onClear = vi.fn();
    const poller = createEStopPoller({
      statusUrl: 'https://example/status',
      onPress,
      onClear,
      fetch: fetchMock,
    });

    await poller.poll(); // first observation: pressed=false, no event
    pressed = true;
    await poller.poll();
    expect(onPress).toHaveBeenCalledOnce();
    expect(onClear).not.toHaveBeenCalled();
  });

  it('fires onClear on true → false transition', async () => {
    let pressed = true;
    const fetchMock = vi.fn(async () => stateResponse({ pressed }));
    const onPress = vi.fn();
    const onClear = vi.fn();
    const poller = createEStopPoller({
      statusUrl: 'https://example/status',
      onPress,
      onClear,
      fetch: fetchMock,
    });

    await poller.poll(); // first observation
    pressed = false;
    await poller.poll();
    expect(onClear).toHaveBeenCalledOnce();
    expect(onPress).not.toHaveBeenCalled();
  });

  it('does not fire on stable observations', async () => {
    const fetchMock = vi.fn(async () => stateResponse({ pressed: false }));
    const onPress = vi.fn();
    const onClear = vi.fn();
    const poller = createEStopPoller({
      statusUrl: 'https://example/status',
      onPress,
      onClear,
      fetch: fetchMock,
    });
    await poller.poll();
    await poller.poll();
    await poller.poll();
    expect(onPress).not.toHaveBeenCalled();
    expect(onClear).not.toHaveBeenCalled();
  });

  it('reports errors via onError on non-2xx', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 500 }));
    const onError = vi.fn();
    const poller = createEStopPoller({
      statusUrl: 'https://example/status',
      onPress: vi.fn(),
      onClear: vi.fn(),
      fetch: fetchMock,
      onError,
    });
    await poller.poll();
    expect(onError).toHaveBeenCalledOnce();
    const err = onError.mock.calls[0]?.[0] as Error;
    expect(err.message).toBe('status_500');
  });

  it('reports errors on invalid response shape', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ not_a_state: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const onError = vi.fn();
    const poller = createEStopPoller({
      statusUrl: 'https://example/status',
      onPress: vi.fn(),
      onClear: vi.fn(),
      fetch: fetchMock,
      onError,
    });
    await poller.poll();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('reports thrown errors via onError', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });
    const onError = vi.fn();
    const poller = createEStopPoller({
      statusUrl: 'https://example/status',
      onPress: vi.fn(),
      onClear: vi.fn(),
      fetch: fetchMock,
      onError,
    });
    await poller.poll();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('tolerates absent onError', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });
    const poller = createEStopPoller({
      statusUrl: 'https://example/status',
      onPress: vi.fn(),
      onClear: vi.fn(),
      fetch: fetchMock,
    });
    await poller.poll(); // should not throw
  });

  it('rejects non-boolean pressed field', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ pressed: 'yes' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const onError = vi.fn();
    const poller = createEStopPoller({
      statusUrl: 'https://example/status',
      onPress: vi.fn(),
      onClear: vi.fn(),
      fetch: fetchMock,
      onError,
    });
    await poller.poll();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('rejects non-string pressedAt / clearedAt', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ pressed: true, pressedAt: 7 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const onError = vi.fn();
    const poller = createEStopPoller({
      statusUrl: 'https://example/status',
      onPress: vi.fn(),
      onClear: vi.fn(),
      fetch: fetchMock,
      onError,
    });
    await poller.poll();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('rejects non-object root', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify('hi'), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const onError = vi.fn();
    const poller = createEStopPoller({
      statusUrl: 'https://example/status',
      onPress: vi.fn(),
      onClear: vi.fn(),
      fetch: fetchMock,
      onError,
    });
    await poller.poll();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('start + stop run a real interval', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async () => stateResponse({ pressed: false }));
      const poller = createEStopPoller({
        statusUrl: 'https://example/status',
        onPress: vi.fn(),
        onClear: vi.fn(),
        fetch: fetchMock,
        intervalMs: 1000,
      });

      poller.start();
      // start kicks off immediately + sets interval; one immediate call,
      // plus N more for the ticks we advance.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(3000);
      await poller.stop();
      await poller.stop(); // idempotent
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);

      poller.start(); // restart
      poller.start(); // idempotent — second start should be no-op
      await poller.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects non-string clearedAt', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ pressed: false, clearedAt: 7 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const onError = vi.fn();
    const poller = createEStopPoller({
      statusUrl: 'https://example/status',
      onPress: vi.fn(),
      onClear: vi.fn(),
      fetch: fetchMock,
      onError,
    });
    await poller.poll();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('falls back to global fetch when not configured', async () => {
    const stub = vi.fn(async () => stateResponse({ pressed: false }));
    vi.stubGlobal('fetch', stub);
    try {
      const poller = createEStopPoller({
        statusUrl: 'https://example/status',
        onPress: vi.fn(),
        onClear: vi.fn(),
      });
      await poller.poll();
      expect(stub).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses default interval when intervalMs not supplied', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async () => stateResponse({ pressed: false }));
      const poller = createEStopPoller({
        statusUrl: 'https://example/status',
        onPress: vi.fn(),
        onClear: vi.fn(),
        fetch: fetchMock,
      });
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      await poller.stop();
      expect(fetchMock).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
