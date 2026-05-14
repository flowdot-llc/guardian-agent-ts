import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditLogWriter } from '../../src/audit/writer.js';
import { generateEd25519KeyPair } from '../../src/audit/signature.js';
import { parseArgs, runVerify, usageString } from '../../src/cli/guardian-verify.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'guardian-verify-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function writeUnsignedLog(path: string): Promise<void> {
  const w = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
  for (let i = 0; i < 3; i++) {
    await w.append({
      kind: 'tool_call',
      status: 'pending',
      initiator: 'agent',
      tool: { name: `t${i}`, args: {} },
    });
  }
  await w.close();
}

describe('parseArgs', () => {
  it('parses positional path', () => {
    const r = parseArgs(['file.jsonl']);
    expect(r?.path).toBe('file.jsonl');
    expect(r?.pubkeyPath).toBeUndefined();
  });

  it('parses --pubkey flag', () => {
    const r = parseArgs(['file.jsonl', '--pubkey', 'key.pem']);
    expect(r?.path).toBe('file.jsonl');
    expect(r?.pubkeyPath).toBe('key.pem');
  });

  it('parses --pubkey before positional', () => {
    const r = parseArgs(['--pubkey', 'key.pem', 'file.jsonl']);
    expect(r?.path).toBe('file.jsonl');
    expect(r?.pubkeyPath).toBe('key.pem');
  });

  it('returns sentinel for --help', () => {
    const r = parseArgs(['--help']);
    expect(r).toEqual({ path: undefined, pubkeyPath: undefined });
  });

  it('returns sentinel for -h', () => {
    expect(parseArgs(['-h'])).toEqual({ path: undefined, pubkeyPath: undefined });
  });

  it('returns null on unknown flag', () => {
    expect(parseArgs(['--unknown'])).toBeNull();
  });

  it('returns null on missing pubkey value', () => {
    expect(parseArgs(['file.jsonl', '--pubkey'])).toBeNull();
  });

  it('returns null on multiple positionals', () => {
    expect(parseArgs(['a.jsonl', 'b.jsonl'])).toBeNull();
  });

  it('returns empty result on no args', () => {
    expect(parseArgs([])).toEqual({ path: undefined, pubkeyPath: undefined });
  });
});

describe('runVerify', () => {
  it('returns usage error exit code 2 when path missing', async () => {
    const r = await runVerify({ path: undefined, pubkeyPath: undefined });
    expect(r.exitCode).toBe(2);
    expect(r.message).toContain('guardian-verify');
  });

  it('verifies chain only when no pubkey given', async () => {
    const path = join(tmp, 'audit.jsonl');
    await writeUnsignedLog(path);
    const r = await runVerify({ path, pubkeyPath: undefined });
    expect(r.exitCode).toBe(0);
    expect(r.recordCount).toBe(3);
    expect(r.chainVerified).toBe(true);
    expect(r.signaturesVerified).toBe(false);
    expect(r.message).toContain('chain ok');
  });

  it('reports chain failure on tampered log', async () => {
    const path = join(tmp, 'audit.jsonl');
    await writeUnsignedLog(path);
    // Tamper.
    const { readFile } = await import('node:fs/promises');
    const buf = await readFile(path, 'utf-8');
    const lines = buf.split('\n').filter((l) => l.length > 0);
    const parsed = JSON.parse(lines[1] as string);
    parsed.prev_hash = 'sha256:deadbeef';
    lines[1] = JSON.stringify(parsed);
    await writeFile(path, lines.join('\n') + '\n');

    const r = await runVerify({ path, pubkeyPath: undefined });
    expect(r.exitCode).toBe(1);
    expect(r.message).toContain('chain verification failed');
  });

  it('verifies chain + signatures with pubkey', async () => {
    const path = join(tmp, 'audit.jsonl');
    const { privateKey, publicKey } = generateEd25519KeyPair();
    const w = new AuditLogWriter({
      path,
      agentId: 'a',
      sessionId: 's',
      signWith: privateKey,
    });
    await w.append({ kind: 'tool_call', status: 'pending', initiator: 'agent' });
    await w.close();

    const pubPath = join(tmp, 'pub.pem');
    await writeFile(pubPath, publicKey.export({ type: 'spki', format: 'pem' }));

    const r = await runVerify({ path, pubkeyPath: pubPath });
    expect(r.exitCode).toBe(0);
    expect(r.signaturesVerified).toBe(true);
    expect(r.message).toContain('signatures ok');
  });

  it('reports signature failure on unsigned log when pubkey given', async () => {
    const path = join(tmp, 'audit.jsonl');
    await writeUnsignedLog(path);
    const { publicKey } = generateEd25519KeyPair();
    const pubPath = join(tmp, 'pub.pem');
    await writeFile(pubPath, publicKey.export({ type: 'spki', format: 'pem' }));

    const r = await runVerify({ path, pubkeyPath: pubPath });
    expect(r.exitCode).toBe(1);
    expect(r.message).toContain('signature verification failed');
  });
});

describe('usageString', () => {
  it('includes the command name and key flags', () => {
    const s = usageString();
    expect(s).toContain('guardian-verify');
    expect(s).toContain('--pubkey');
  });
});
