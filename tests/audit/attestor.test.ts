import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditLogReader } from '../../src/audit/reader.js';
import { AuditLogWriter } from '../../src/audit/writer.js';
import {
  httpAttestor,
  nullAttestor,
  payloadFromRecord,
  type AttestationPayload,
  type AttestationReceipt,
  type Attestor,
} from '../../src/audit/attestor.js';
import type { AuditRecord } from '../../src/types.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'attestor-'));
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

describe('payloadFromRecord', () => {
  it('builds a v=1 payload with the supplied head hash', () => {
    const rec = {
      agent_id: 'a',
      session_id: 's',
      signature: 'ed25519:abc',
    } as unknown as AuditRecord;
    const p = payloadFromRecord(rec, 42, 'sha256:deadbeef');
    expect(p).toMatchObject({
      v: '1',
      agentId: 'a',
      sessionId: 's',
      head: 'sha256:deadbeef',
      signature: 'ed25519:abc',
      recordCount: 42,
    });
    expect(typeof p.ts).toBe('string');
  });

  it('normalizes missing signature to null', () => {
    const rec = { agent_id: 'a', session_id: 's' } as unknown as AuditRecord;
    const p = payloadFromRecord(rec, 1, 'sha256:x');
    expect(p.signature).toBeNull();
  });
});

describe('nullAttestor', () => {
  it('returns synthetic receipts with monotonically-increasing ids', async () => {
    const a = nullAttestor();
    const r1 = await a.publish({} as AttestationPayload);
    const r2 = await a.publish({} as AttestationPayload);
    expect(r1.receiptId).toBe('null-1');
    expect(r2.receiptId).toBe('null-2');
  });
});

describe('httpAttestor', () => {
  it('POSTs the payload as JSON and returns the parsed receipt', async () => {
    const calls: { url: string; body: AttestationPayload }[] = [];
    const fetchImpl: typeof fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) as AttestationPayload });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ receiptId: 'r-1', url: 'http://example/r-1' }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const a = httpAttestor({ url: 'http://example/attest', fetchImpl });
    const receipt = await a.publish({
      v: '1',
      agentId: 'a',
      sessionId: 's',
      head: 'sha256:x',
      signature: null,
      recordCount: 10,
      ts: '2026-01-01T00:00:00.000Z',
    });
    expect(receipt).toEqual({ receiptId: 'r-1', url: 'http://example/r-1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.head).toBe('sha256:x');
  });

  it('throws on non-2xx', async () => {
    const fetchImpl = (async () =>
      ({ ok: false, status: 503, statusText: 'busy', json: async () => ({}) } as unknown as Response)) as unknown as typeof fetch;
    const a = httpAttestor({ url: 'http://example/attest', fetchImpl });
    await expect(
      a.publish({ v: '1', agentId: 'a', sessionId: 's', head: '', signature: null, recordCount: 0, ts: '' }),
    ).rejects.toThrow(/503/);
  });

  it('throws when response lacks receiptId', async () => {
    const fetchImpl = (async () =>
      ({ ok: true, status: 200, statusText: 'OK', json: async () => ({}) } as unknown as Response)) as unknown as typeof fetch;
    const a = httpAttestor({ url: 'http://example/attest', fetchImpl });
    await expect(
      a.publish({ v: '1', agentId: 'a', sessionId: 's', head: '', signature: null, recordCount: 0, ts: '' }),
    ).rejects.toThrow(/receiptId/);
  });

  it('rejects construction when fetch is unavailable and no override supplied', () => {
    const realFetch = globalThis.fetch;
    (globalThis as unknown as { fetch: unknown }).fetch = undefined;
    try {
      expect(() => httpAttestor({ url: 'http://x' })).toThrow(/fetch/);
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = realFetch;
    }
  });
});

describe('AuditLogWriter + attestor', () => {
  function recordingAttestor(): Attestor & { calls: AttestationPayload[] } {
    const calls: AttestationPayload[] = [];
    return {
      calls,
      publish: (p: AttestationPayload) => {
        calls.push(p);
        return { receiptId: `r-${calls.length}` };
      },
    };
  }

  it('rejects attestEvery <= 0', () => {
    expect(
      () =>
        new AuditLogWriter({
          path: join(tmp, 'a.jsonl'),
          agentId: 'a',
          sessionId: 's',
          attestor: nullAttestor(),
          attestEvery: 0,
        }),
    ).toThrow(/attestEvery/);
  });

  it('writes x_chain_attested every N records', async () => {
    const attestor = recordingAttestor();
    const path = join(tmp, 'audit.jsonl');
    const w = new AuditLogWriter({
      path,
      agentId: 'a',
      sessionId: 's',
      attestor,
      attestEvery: 3,
      attestOnClose: false,
    });
    for (let i = 0; i < 6; i++) {
      await w.append({ kind: 'tool_call', status: 'pending', initiator: 'agent' });
    }
    // Give microtasks time to drain (attestation is fire-and-forget within the
    // queue, but the queue serializes).
    await w.close();

    expect(attestor.calls.length).toBeGreaterThanOrEqual(2);
    const recs = await readAll(path);
    const attested = recs.filter((r) => r.kind === ('x_chain_attested' as unknown));
    expect(attested.length).toBeGreaterThanOrEqual(2);
    expect(attested[0]?.detail?.receipt_id).toBe('r-1');
  });

  it('attests on close when attestOnClose=true', async () => {
    const attestor = recordingAttestor();
    const path = join(tmp, 'audit.jsonl');
    const w = new AuditLogWriter({
      path,
      agentId: 'a',
      sessionId: 's',
      attestor,
      attestEvery: 100, // won't fire mid-stream
      attestOnClose: true,
    });
    await w.append({ kind: 'tool_call', status: 'pending', initiator: 'agent' });
    await w.append({ kind: 'tool_call', status: 'pending', initiator: 'agent' });
    await w.close();

    expect(attestor.calls).toHaveLength(1);
    const recs = await readAll(path);
    expect(recs.some((r) => r.kind === ('x_chain_attested' as unknown))).toBe(true);
  });

  it('writes x_chain_attestation_failed and continues when attestor throws', async () => {
    const failing: Attestor = {
      publish: () => {
        throw new Error('network unavailable');
      },
    };
    const path = join(tmp, 'audit.jsonl');
    const w = new AuditLogWriter({
      path,
      agentId: 'a',
      sessionId: 's',
      attestor: failing,
      attestEvery: 1,
      attestOnClose: false,
    });
    await w.append({ kind: 'tool_call', status: 'pending', initiator: 'agent' });
    await w.close();

    const recs = await readAll(path);
    const failed = recs.find((r) => r.kind === ('x_chain_attestation_failed' as unknown));
    expect(failed).toBeDefined();
    expect(failed?.detail?.error).toMatch(/network unavailable/);
  });

  it('does not recurse: attestation rows do not themselves trigger attestations', async () => {
    const attestor = recordingAttestor();
    const path = join(tmp, 'audit.jsonl');
    const w = new AuditLogWriter({
      path,
      agentId: 'a',
      sessionId: 's',
      attestor,
      attestEvery: 1,
      attestOnClose: false,
    });
    await w.append({ kind: 'tool_call', status: 'pending', initiator: 'agent' });
    await w.close();
    // One real record → one publish call. Recursion would yield >1.
    expect(attestor.calls).toHaveLength(1);
  });

  it('does not attest when no records have been appended (attestOnClose=true)', async () => {
    const attestor = recordingAttestor();
    const path = join(tmp, 'audit.jsonl');
    const w = new AuditLogWriter({
      path,
      agentId: 'a',
      sessionId: 's',
      attestor,
      attestOnClose: true,
    });
    await w.close();
    expect(attestor.calls).toHaveLength(0);
  });

  it('runAttestation is a no-op when no attestor configured', async () => {
    const path = join(tmp, 'audit.jsonl');
    const w = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    await w.append({ kind: 'tool_call', status: 'pending', initiator: 'agent' });
    await w.runAttestation(); // should not throw
    await w.close();
    const recs = await readAll(path);
    expect(recs.some((r) => r.kind === ('x_chain_attested' as unknown))).toBe(false);
  });

  it('records receipt_url on x_chain_attested when attestor returns one', async () => {
    const a: Attestor = {
      publish: () => ({ receiptId: 'r-x', url: 'http://example/r-x' }),
    };
    const path = join(tmp, 'audit.jsonl');
    const w = new AuditLogWriter({
      path,
      agentId: 'a',
      sessionId: 's',
      attestor: a,
      attestEvery: 1,
      attestOnClose: false,
    });
    await w.append({ kind: 'tool_call', status: 'pending', initiator: 'agent' });
    await w.close();
    const recs = await readAll(path);
    const attested = recs.find((r) => r.kind === ('x_chain_attested' as unknown));
    expect(attested?.detail?.receipt_url).toBe('http://example/r-x');
  });

  it('stringifies non-Error throws when recording attestation failure', async () => {
    const a: Attestor = {
      publish: () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw 'plain string failure'; // non-Error
      },
    };
    const path = join(tmp, 'audit.jsonl');
    const w = new AuditLogWriter({
      path,
      agentId: 'a',
      sessionId: 's',
      attestor: a,
      attestEvery: 1,
      attestOnClose: false,
    });
    await w.append({ kind: 'tool_call', status: 'pending', initiator: 'agent' });
    await w.close();
    const recs = await readAll(path);
    const failed = recs.find((r) => r.kind === ('x_chain_attestation_failed' as unknown));
    expect(failed?.detail?.error).toBe('plain string failure');
  });

  it('runAttestation is a no-op after close()', async () => {
    const attestor = recordingAttestor();
    const path = join(tmp, 'audit.jsonl');
    const w = new AuditLogWriter({
      path,
      agentId: 'a',
      sessionId: 's',
      attestor,
      attestOnClose: false,
    });
    await w.append({ kind: 'tool_call', status: 'pending', initiator: 'agent' });
    await w.close();
    const before = attestor.calls.length;
    await w.runAttestation();
    expect(attestor.calls).toHaveLength(before);
  });
});
