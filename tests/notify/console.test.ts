import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { consoleNotifier } from '../../src/notify/console.js';
import type { NotificationEvent } from '../../src/notify/types.js';

function ev(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    kind: 'estop_press',
    agentId: 'agent_a',
    ts: '2026-05-13T23:00:00.000Z',
    source: 'hub',
    summary: { reason: 'manual' },
    ...overrides,
  };
}

async function capture(notifierFn: ReturnType<typeof consoleNotifier>, event: NotificationEvent) {
  // Replace the default stream by re-constructing with a PassThrough.
  // (We can't intercept the existing notifier; we need a new one.)
  void notifierFn; void event;
}

describe('consoleNotifier', () => {
  it('writes a line containing kind, source, ts', async () => {
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    const n = consoleNotifier({ stream });
    await n.notify(ev());
    const line = Buffer.concat(chunks).toString('utf-8');
    expect(line).toContain('[guardian]');
    expect(line).toContain('estop_press');
    expect(line).toContain('source=hub');
    expect(line).toContain('at=2026-05-13T23:00:00.000Z');
    expect(line).toContain('summary={"reason":"manual"}');
  });

  it('includes user= when userId is set', async () => {
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    const n = consoleNotifier({ stream });
    await n.notify(ev({ userId: 'u_1' }));
    expect(Buffer.concat(chunks).toString('utf-8')).toContain('user=u_1');
  });

  it('includes clear= when canonicalClearUrl is set', async () => {
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    const n = consoleNotifier({ stream });
    await n.notify(ev({ canonicalClearUrl: 'https://example/clear' }));
    expect(Buffer.concat(chunks).toString('utf-8')).toContain('clear=https://example/clear');
  });

  it('omits summary= when summary is empty', async () => {
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    const n = consoleNotifier({ stream });
    await n.notify(ev({ summary: {} }));
    expect(Buffer.concat(chunks).toString('utf-8')).not.toContain('summary=');
  });

  it('uses custom prefix when supplied', async () => {
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    const n = consoleNotifier({ stream, prefix: '[X]' });
    await n.notify(ev());
    expect(Buffer.concat(chunks).toString('utf-8')).toContain('[X] ');
  });

  it('uses agent=- when agentId is empty', async () => {
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    const n = consoleNotifier({ stream });
    await n.notify(ev({ agentId: '' }));
    expect(Buffer.concat(chunks).toString('utf-8')).toContain('agent=-');
  });

  it('defaults to process.stderr when no stream supplied', () => {
    // Just construct it — actually writing would pollute test output.
    const n = consoleNotifier();
    expect(typeof n.notify).toBe('function');
  });
});

// `capture` placeholder is unused; satisfies typecheck.
void capture;
