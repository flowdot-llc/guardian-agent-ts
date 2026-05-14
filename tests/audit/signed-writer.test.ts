import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditLogWriter } from '../../src/audit/writer.js';
import { AuditLogReader } from '../../src/audit/reader.js';
import { generateEd25519KeyPair } from '../../src/audit/signature.js';
import { GuardianIntegrityError } from '../../src/errors.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'guardian-signed-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('signed audit log round-trip', () => {
  it('writer signs every record; reader.verifySignatures passes', async () => {
    const path = join(tmp, 'audit.jsonl');
    const { privateKey, publicKey } = generateEd25519KeyPair();
    const w = new AuditLogWriter({
      path,
      agentId: 'a',
      sessionId: 's',
      signWith: privateKey,
    });
    for (let i = 0; i < 3; i++) {
      await w.append({
        kind: 'tool_call',
        status: 'pending',
        initiator: 'agent',
        tool: { name: `t${i}`, args: {} },
      });
    }
    await w.close();

    const reader = await AuditLogReader.open(path);
    const count = await reader.verifySignatures(publicKey);
    await reader.close();
    expect(count).toBe(3);
  });

  it('reader.verifySignatures throws on missing signature', async () => {
    const path = join(tmp, 'audit.jsonl');
    const w = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    await w.append({ kind: 'tool_call', status: 'pending', initiator: 'agent' });
    await w.close();

    const { publicKey } = generateEd25519KeyPair();
    const reader = await AuditLogReader.open(path);
    await expect(reader.verifySignatures(publicKey)).rejects.toBeInstanceOf(
      GuardianIntegrityError,
    );
    await reader.close();
  });

  it('reader.verifySignatures throws on tampered signature', async () => {
    const path = join(tmp, 'audit.jsonl');
    const { privateKey } = generateEd25519KeyPair();
    const { publicKey: otherPub } = generateEd25519KeyPair();
    const w = new AuditLogWriter({
      path,
      agentId: 'a',
      sessionId: 's',
      signWith: privateKey,
    });
    await w.append({ kind: 'tool_call', status: 'pending', initiator: 'agent' });
    await w.close();

    const reader = await AuditLogReader.open(path);
    await expect(reader.verifySignatures(otherPub)).rejects.toBeInstanceOf(
      GuardianIntegrityError,
    );
    await reader.close();
  });
});
