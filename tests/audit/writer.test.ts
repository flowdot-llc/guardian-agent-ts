import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditLogWriter } from '../../src/audit/writer.js';
import { GENESIS_HASH, computeRecordHash } from '../../src/audit/chain.js';
import type { AuditRecord } from '../../src/types.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'guardian-test-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('AuditLogWriter', () => {
  it('appends a single record with genesis prev_hash', async () => {
    const path = join(tmp, 'audit.jsonl');
    const w = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const r = await w.append({
      kind: 'tool_call',
      status: 'pending',
      initiator: 'agent',
      tool: { name: 'list_accounts', args: { broker: 'x' } },
    });
    await w.close();

    expect(r.prev_hash).toBe(GENESIS_HASH);
    expect(r.event_id).toMatch(/^evt_/);
    expect(r.agent_id).toBe('a');
    expect(r.session_id).toBe('s');
    expect(r.signature).toBeNull();

    const contents = await readFile(path, 'utf-8');
    const lines = contents.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] as string) as AuditRecord;
    expect(parsed.event_id).toBe(r.event_id);
  });

  it('chains records via prev_hash', async () => {
    const path = join(tmp, 'audit.jsonl');
    const w = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });

    const r1 = await w.append({ kind: 'session_open', status: 'approved', initiator: 'system' });
    const r2 = await w.append({
      kind: 'tool_call',
      status: 'pending',
      initiator: 'agent',
      tool: { name: 't', args: {} },
    });
    const r3 = await w.append({
      kind: 'tool_result',
      status: 'executed',
      initiator: 'system',
      tool: { name: 't', args: {}, result: 1, duration_ms: 5 },
    });
    await w.close();

    expect(r1.prev_hash).toBe(GENESIS_HASH);
    expect(r2.prev_hash).toBe(computeRecordHash(r1));
    expect(r3.prev_hash).toBe(computeRecordHash(r2));
    expect(w.tipHash).toBe(computeRecordHash(r3));
  });

  it('serializes concurrent appends via the internal queue', async () => {
    const path = join(tmp, 'audit.jsonl');
    const w = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        w.append({
          kind: 'tool_call',
          status: 'pending',
          initiator: 'agent',
          tool: { name: `t${i}`, args: {} },
        }),
      ),
    );
    await w.close();

    let expected = GENESIS_HASH;
    for (const r of results) {
      expect(r.prev_hash).toBe(expected);
      expected = computeRecordHash(r);
    }
  });

  it('recovers tipHash on re-open of an existing file', async () => {
    const path = join(tmp, 'audit.jsonl');

    const w1 = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const r1 = await w1.append({ kind: 'session_open', status: 'approved', initiator: 'system' });
    await w1.close();

    const w2 = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    await w2.open();
    expect(w2.tipHash).toBe(computeRecordHash(r1));

    const r2 = await w2.append({
      kind: 'tool_call',
      status: 'pending',
      initiator: 'agent',
      tool: { name: 't', args: {} },
    });
    expect(r2.prev_hash).toBe(computeRecordHash(r1));
    await w2.close();
  });

  it('fires onTipRecovered with the recovered record', async () => {
    const path = join(tmp, 'audit.jsonl');
    const w1 = new AuditLogWriter({ path, agentId: 'a', sessionId: 's1' });
    const r1 = await w1.append({
      kind: 'tool_call',
      status: 'pending',
      initiator: 'agent',
      tool: { name: 'x', args: {} },
    });
    await w1.close();

    const calls: unknown[] = [];
    const w2 = new AuditLogWriter({
      path,
      agentId: 'a',
      sessionId: 's2',
      onTipRecovered: (rec) => {
        calls.push(rec);
      },
    });
    await w2.open();
    await w2.close();

    expect(calls).toHaveLength(1);
    expect((calls[0] as { event_id: string }).event_id).toBe(r1.event_id);
  });

  it('does not fire onTipRecovered on a fresh file', async () => {
    const path = join(tmp, 'audit.jsonl');
    const calls: unknown[] = [];
    const w = new AuditLogWriter({
      path,
      agentId: 'a',
      sessionId: 's',
      onTipRecovered: (rec) => {
        calls.push(rec);
      },
    });
    await w.open();
    await w.close();
    expect(calls).toHaveLength(0);
  });

  it('does not fire onTipRecovered when file has only blank lines', async () => {
    const path = join(tmp, 'audit.jsonl');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, '\n\n\n');
    const calls: unknown[] = [];
    const w = new AuditLogWriter({
      path,
      agentId: 'a',
      sessionId: 's',
      onTipRecovered: (rec) => {
        calls.push(rec);
      },
    });
    await w.open();
    await w.close();
    expect(calls).toHaveLength(0);
  });

  it('supports async onTipRecovered', async () => {
    const path = join(tmp, 'audit.jsonl');
    const w1 = new AuditLogWriter({ path, agentId: 'a', sessionId: 's1' });
    await w1.append({ kind: 'session_open', status: 'approved', initiator: 'system' });
    await w1.close();

    let fired = false;
    const w2 = new AuditLogWriter({
      path,
      agentId: 'a',
      sessionId: 's2',
      onTipRecovered: async () => {
        await new Promise((r) => setTimeout(r, 1));
        fired = true;
      },
    });
    await w2.open();
    await w2.close();
    expect(fired).toBe(true);
  });

  it('returns GENESIS_HASH on re-open of a file with only blank lines', async () => {
    const path = join(tmp, 'audit.jsonl');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, '\n\n\n');

    const w = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    await w.open();
    // The recoverTipHash for-loop iterates and never finds a non-empty line,
    // so it falls through to the final GENESIS_HASH return.
    expect(w.tipHash).toBe(GENESIS_HASH);
    await w.close();
  });

  it('returns GENESIS_HASH on re-open of an empty file', async () => {
    const path = join(tmp, 'audit.jsonl');
    // Create the file empty.
    const w1 = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    await w1.open();
    await w1.close();

    const w2 = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    await w2.open();
    expect(w2.tipHash).toBe(GENESIS_HASH);
    await w2.close();
  });

  it('open is idempotent', async () => {
    const path = join(tmp, 'audit.jsonl');
    const w = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    await w.open();
    await w.open();
    await w.close();
  });

  it('close is idempotent', async () => {
    const path = join(tmp, 'audit.jsonl');
    const w = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    await w.close();
    await w.close();
  });

  it('refuses append after close', async () => {
    const path = join(tmp, 'audit.jsonl');
    const w = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    await w.close();
    await expect(
      w.append({ kind: 'tool_call', status: 'pending', initiator: 'agent' }),
    ).rejects.toThrow(/closed/);
  });

  it('allows per-append agentId/sessionId override', async () => {
    const path = join(tmp, 'audit.jsonl');
    const w = new AuditLogWriter({ path, agentId: 'default', sessionId: 's' });
    const r = await w.append({
      agentId: 'override',
      sessionId: 'sess_override',
      kind: 'tool_call',
      status: 'pending',
      initiator: 'agent',
    });
    expect(r.agent_id).toBe('override');
    expect(r.session_id).toBe('sess_override');
    await w.close();
  });

  it('survives one append failure and continues with next appends', async () => {
    const path = join(tmp, 'audit.jsonl');
    const w = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    await w.open();

    // Inject a temporary write failure by stubbing the file handle.
    // Use any to dodge private-field type checks — this is intentional.
    const wAny = w as unknown as { handle: { write: (s: string) => Promise<unknown>; sync: () => Promise<unknown> } };
    const realWrite = wAny.handle.write.bind(wAny.handle);
    let failed = false;
    wAny.handle.write = (s: string) => {
      if (!failed) {
        failed = true;
        return Promise.reject(new Error('disk full'));
      }
      return realWrite(s);
    };

    await expect(
      w.append({ kind: 'tool_call', status: 'pending', initiator: 'agent' }),
    ).rejects.toThrow(/disk full/);

    const r2 = await w.append({
      kind: 'tool_call',
      status: 'pending',
      initiator: 'agent',
    });
    // After a failed append the tip hash stays at GENESIS because no record was written.
    expect(r2.prev_hash).toBe(GENESIS_HASH);
    await w.close();
  });

  it('appends model attribution when supplied', async () => {
    const path = join(tmp, 'audit.jsonl');
    const w = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const r = await w.append({
      kind: 'tool_call',
      status: 'pending',
      initiator: 'agent',
      model: { provider: 'anthropic', id: 'claude-opus-4', input_tokens: 1, output_tokens: 2 },
    });
    expect(r.model).toEqual({
      provider: 'anthropic',
      id: 'claude-opus-4',
      input_tokens: 1,
      output_tokens: 2,
    });
    await w.close();
  });

  it('appends detail when supplied', async () => {
    const path = join(tmp, 'audit.jsonl');
    const w = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const r = await w.append({
      kind: 'estop_press',
      status: 'halted',
      initiator: 'operator',
      detail: { reason: 'manual_halt', ip: '127.0.0.1' },
    });
    expect(r.detail).toEqual({ reason: 'manual_halt', ip: '127.0.0.1' });
    await w.close();
  });

  it('close drains a queue that ended in failure', async () => {
    const path = join(tmp, 'audit.jsonl');
    const w = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    await w.open();
    const wAny = w as unknown as { handle: { write: () => Promise<unknown> } };
    wAny.handle.write = () => Promise.reject(new Error('disk explode'));
    const failing = w.append({ kind: 'tool_call', status: 'pending', initiator: 'agent' });
    // Catch the failure but don't await before close().
    failing.catch(() => undefined);
    // close() must not throw even though the queue has a rejection.
    await w.close();
  });

  it('tolerates fsync failure', async () => {
    const path = join(tmp, 'audit.jsonl');
    const w = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    await w.open();
    const wAny = w as unknown as { handle: { sync: () => Promise<unknown> } };
    wAny.handle.sync = () => Promise.reject(new Error('fsync unsupported'));

    const r = await w.append({
      kind: 'tool_call',
      status: 'pending',
      initiator: 'agent',
    });
    expect(r.event_id).toMatch(/^evt_/);
    await w.close();
  });
});
