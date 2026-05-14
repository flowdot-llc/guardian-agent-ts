import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditLogReader } from '../../src/audit/reader.js';
import { AuditLogWriter } from '../../src/audit/writer.js';
import { GuardianIntegrityError } from '../../src/errors.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'guardian-reader-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function writeSample(path: string, count = 3): Promise<void> {
  const w = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
  for (let i = 0; i < count; i++) {
    await w.append({
      kind: 'tool_call',
      status: 'pending',
      initiator: 'agent',
      tool: { name: `t${i}`, args: {} },
    });
  }
  await w.close();
}

describe('AuditLogReader', () => {
  it('iterates records in order', async () => {
    const path = join(tmp, 'audit.jsonl');
    await writeSample(path, 3);

    const reader = await AuditLogReader.open(path);
    const records = [];
    for await (const r of reader.records()) records.push(r);
    await reader.close();

    expect(records).toHaveLength(3);
    expect(records[0]?.tool?.name).toBe('t0');
    expect(records[2]?.tool?.name).toBe('t2');
  });

  it('verifies an intact hash chain', async () => {
    const path = join(tmp, 'audit.jsonl');
    await writeSample(path, 5);

    const reader = await AuditLogReader.open(path);
    const count = await reader.verifyChain();
    await reader.close();
    expect(count).toBe(5);
  });

  it('throws GuardianIntegrityError on broken chain', async () => {
    const path = join(tmp, 'audit.jsonl');
    await writeSample(path, 3);

    // Read the file, tamper with the second record's prev_hash, write back.
    const { readFile, writeFile } = await import('node:fs/promises');
    const buf = await readFile(path, 'utf-8');
    const lines = buf.split('\n').filter((l) => l.length > 0);
    const second = JSON.parse(lines[1] as string);
    second.prev_hash = 'sha256:deadbeef';
    lines[1] = JSON.stringify(second);
    await writeFile(path, lines.join('\n') + '\n');

    const reader = await AuditLogReader.open(path);
    await expect(reader.verifyChain()).rejects.toBeInstanceOf(GuardianIntegrityError);
    await reader.close();
  });

  it('throws on truncated chain', async () => {
    const path = join(tmp, 'audit.jsonl');
    await writeSample(path, 3);

    // Append a record with a wrong prev_hash directly.
    await appendFile(
      path,
      JSON.stringify({
        v: '0.2.0',
        event_id: 'evt_fake',
        ts: '2026-05-13T00:00:00.000Z',
        agent_id: 'a',
        session_id: 's',
        kind: 'tool_call',
        status: 'pending',
        initiator: 'agent',
        prev_hash: 'sha256:wrong',
        signature: null,
      }) + '\n',
    );

    const reader = await AuditLogReader.open(path);
    await expect(reader.verifyChain()).rejects.toBeInstanceOf(GuardianIntegrityError);
    await reader.close();
  });

  it('handles empty file', async () => {
    const path = join(tmp, 'audit.jsonl');
    await writeFile(path, '');

    const reader = await AuditLogReader.open(path);
    expect(await reader.verifyChain()).toBe(0);
    const records = [];
    for await (const r of reader.records()) records.push(r);
    expect(records).toHaveLength(0);
    await reader.close();
  });

  it('skips empty lines in the file', async () => {
    const path = join(tmp, 'audit.jsonl');
    await writeSample(path, 2);
    // Insert blank lines between records.
    const { readFile, writeFile } = await import('node:fs/promises');
    const content = await readFile(path, 'utf-8');
    const withBlanks = content.replace(/\n/g, '\n\n');
    await writeFile(path, withBlanks);

    const reader = await AuditLogReader.open(path);
    const records = [];
    for await (const r of reader.records()) records.push(r);
    await reader.close();
    expect(records).toHaveLength(2);
  });

  it('close is idempotent', async () => {
    const path = join(tmp, 'audit.jsonl');
    await writeSample(path, 1);
    const reader = await AuditLogReader.open(path);
    await reader.close();
    await reader.close();
  });
});
