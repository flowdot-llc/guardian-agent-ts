import { describe, expect, it, vi } from 'vitest';

import { multiNotifier } from '../../src/notify/multi.js';
import type { Notifier, NotificationEvent } from '../../src/notify/types.js';

function ev(): NotificationEvent {
  return {
    kind: 'estop_press',
    agentId: 'a',
    ts: '2026-05-13T23:00:00.000Z',
    source: 'hub',
    summary: {},
  };
}

describe('multiNotifier', () => {
  it('fans out to every child notifier', async () => {
    const a: Notifier = { notify: vi.fn(async () => undefined) };
    const b: Notifier = { notify: vi.fn(async () => undefined) };
    const n = multiNotifier({ notifiers: [a, b] });
    await n.notify(ev());
    expect(a.notify).toHaveBeenCalledOnce();
    expect(b.notify).toHaveBeenCalledOnce();
  });

  it('continues after one child fails and reports via onError', async () => {
    const a: Notifier = {
      notify: vi.fn(async () => {
        throw new Error('a failed');
      }),
    };
    const b: Notifier = { notify: vi.fn(async () => undefined) };
    const onError = vi.fn();
    const n = multiNotifier({ notifiers: [a, b], onError });
    await n.notify(ev());
    expect(b.notify).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
    const [err, , idx] = onError.mock.calls[0] ?? [];
    expect((err as Error).message).toBe('a failed');
    expect(idx).toBe(0);
  });

  it('does not throw when no onError supplied', async () => {
    const a: Notifier = {
      notify: vi.fn(async () => {
        throw new Error('a failed');
      }),
    };
    const n = multiNotifier({ notifiers: [a] });
    await expect(n.notify(ev())).resolves.toBeUndefined();
  });

  it('handles empty notifier list', async () => {
    const n = multiNotifier({ notifiers: [] });
    await expect(n.notify(ev())).resolves.toBeUndefined();
  });
});
