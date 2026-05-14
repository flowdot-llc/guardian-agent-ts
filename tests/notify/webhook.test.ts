import { afterEach, describe, expect, it, vi } from 'vitest';

import { webhookNotifier } from '../../src/notify/webhook.js';
import type { NotificationEvent } from '../../src/notify/types.js';

function ev(): NotificationEvent {
  return {
    kind: 'estop_press',
    agentId: 'a',
    ts: '2026-05-13T23:00:00.000Z',
    source: 'hub',
    summary: { reason: 'r' },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('webhookNotifier', () => {
  it('POSTs the event as JSON', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    const n = webhookNotifier({ url: 'https://example/n', fetch: fetchMock });
    await n.notify(ev());
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example/n');
    expect(init.method).toBe('POST');
    expect(init.body).toContain('"kind":"estop_press"');
  });

  it('forwards extra headers', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    const n = webhookNotifier({
      url: 'https://example/n',
      fetch: fetchMock,
      headers: { authorization: 'Bearer x' },
    });
    await n.notify(ev());
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer x');
  });

  it('calls onError on non-2xx', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 500 }));
    const onError = vi.fn();
    const n = webhookNotifier({
      url: 'https://example/n',
      fetch: fetchMock,
      onError,
    });
    await n.notify(ev());
    expect(onError).toHaveBeenCalledOnce();
    const err = onError.mock.calls[0]?.[0] as Error;
    expect(err.message).toBe('webhook_status_500');
  });

  it('calls onError on thrown error', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('connect refused');
    });
    const onError = vi.fn();
    const n = webhookNotifier({
      url: 'https://example/n',
      fetch: fetchMock,
      onError,
    });
    await n.notify(ev());
    expect(onError).toHaveBeenCalledOnce();
  });

  it('does not throw even without onError', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('connect refused');
    });
    const n = webhookNotifier({ url: 'https://example/n', fetch: fetchMock });
    await expect(n.notify(ev())).resolves.toBeUndefined();
  });

  it('does not throw on non-2xx without onError', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 500 }));
    const n = webhookNotifier({ url: 'https://example/n', fetch: fetchMock });
    await expect(n.notify(ev())).resolves.toBeUndefined();
  });

  it('respects custom timeout', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.signal?.aborted === false) {
        await new Promise<void>((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      throw new Error('aborted');
    });
    const onError = vi.fn();
    const n = webhookNotifier({
      url: 'https://example/n',
      fetch: fetchMock,
      timeoutMs: 5,
      onError,
    });
    await n.notify(ev());
    expect(onError).toHaveBeenCalledOnce();
  });

  it('falls back to global fetch when not configured', async () => {
    const stub = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', stub);
    const n = webhookNotifier({ url: 'https://example/n' });
    await n.notify(ev());
    expect(stub).toHaveBeenCalledOnce();
  });
});
