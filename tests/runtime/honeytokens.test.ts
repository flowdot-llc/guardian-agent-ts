import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditLogReader } from '../../src/audit/reader.js';
import { AuditLogWriter } from '../../src/audit/writer.js';
import { EStopLocal } from '../../src/estop/local.js';
import { GuardianHaltedError } from '../../src/errors.js';
import { GuardianRuntime } from '../../src/runtime/runtime.js';
import {
  checkHoneytoken,
  defineHoneytokenSet,
  matchHoneytokenInArgs,
  matchPhantomTool,
} from '../../src/runtime/honeytokens.js';
import type { AuditRecord } from '../../src/types.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'honeytokens-'));
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

describe('defineHoneytokenSet', () => {
  it('builds a set with value tokens', () => {
    const set = defineHoneytokenSet('s', [{ id: 'k1', value: 'fd_honey_abc' }]);
    expect(set.id).toBe('s');
    expect(set.tokens).toHaveLength(1);
  });

  it('builds a set with phantom tools', () => {
    const set = defineHoneytokenSet('s', [], ['delete_user_account_unsafe']);
    expect(set.phantomTools).toEqual(['delete_user_account_unsafe']);
  });

  it('preserves description', () => {
    const set = defineHoneytokenSet('s', [{ id: 'k', value: 'x' }], [], 'desc');
    expect(set.description).toBe('desc');
  });

  it('omits description when not provided', () => {
    const set = defineHoneytokenSet('s', [{ id: 'k', value: 'x' }]);
    expect(set.description).toBeUndefined();
  });

  it('rejects an empty set (no tokens, no phantoms)', () => {
    expect(() => defineHoneytokenSet('empty', [])).toThrow(/at least one/);
  });

  it('rejects duplicate token ids', () => {
    expect(() =>
      defineHoneytokenSet('s', [
        { id: 'k', value: 'a' },
        { id: 'k', value: 'b' },
      ]),
    ).toThrow(/duplicate token id/);
  });

  it('rejects duplicate phantom names', () => {
    expect(() =>
      defineHoneytokenSet('s', [{ id: 'k', value: 'x' }], ['t', 't']),
    ).toThrow(/duplicate phantom tool/);
  });

  it('rejects a token with neither value nor pattern', () => {
    expect(() => defineHoneytokenSet('s', [{ id: 'k' }])).toThrow(/value or pattern/);
  });

  it('rejects a token with both value and pattern', () => {
    expect(() =>
      defineHoneytokenSet('s', [{ id: 'k', value: 'x', pattern: /x/ }]),
    ).toThrow(/both value and pattern/);
  });
});

describe('matchHoneytokenInArgs', () => {
  it('matches a value at top level', () => {
    const set = defineHoneytokenSet('s', [{ id: 'k', value: 'fd_honey_xyz' }]);
    expect(matchHoneytokenInArgs(set, { creds: 'fd_honey_xyz' })).toEqual({
      kind: 'value_in_args',
      tokenId: 'k',
    });
  });

  it('matches a value nested deep', () => {
    const set = defineHoneytokenSet('s', [{ id: 'k', value: 'fd_honey_xyz' }]);
    expect(
      matchHoneytokenInArgs(set, { outer: { mid: { inner: ['fd_honey_xyz'] } } }),
    ).toEqual({ kind: 'value_in_args', tokenId: 'k' });
  });

  it('matches a regex pattern', () => {
    const set = defineHoneytokenSet('s', [
      { id: 'aws', pattern: /AKIA[0-9A-Z]{16}/ },
    ]);
    expect(matchHoneytokenInArgs(set, { key: 'AKIAABCDEF1234567890' })).toEqual({
      kind: 'value_in_args',
      tokenId: 'aws',
    });
  });

  it('does not match unrelated strings', () => {
    const set = defineHoneytokenSet('s', [{ id: 'k', value: 'fd_honey_xyz' }]);
    expect(matchHoneytokenInArgs(set, { creds: 'real_token' })).toBeNull();
  });

  it('returns null when token set has only phantom tools', () => {
    const set = defineHoneytokenSet('s', [], ['phantom']);
    expect(matchHoneytokenInArgs(set, { x: 1 })).toBeNull();
  });

  it('returns the FIRST matching token id (set declaration order)', () => {
    const set = defineHoneytokenSet('s', [
      { id: 'first', value: 'shared' },
      { id: 'second', value: 'shared' },
    ]);
    expect(matchHoneytokenInArgs(set, { x: 'shared' })?.tokenId).toBe('first');
  });

  it('handles primitive args (numbers, booleans, null)', () => {
    const set = defineHoneytokenSet('s', [{ id: 'k', value: 'magic' }]);
    expect(matchHoneytokenInArgs(set, 42)).toBeNull();
    expect(matchHoneytokenInArgs(set, true)).toBeNull();
    expect(matchHoneytokenInArgs(set, null)).toBeNull();
    expect(matchHoneytokenInArgs(set, 'magic')).toEqual({
      kind: 'value_in_args',
      tokenId: 'k',
    });
  });
});

describe('matchPhantomTool', () => {
  it('matches an exact phantom-tool name', () => {
    const set = defineHoneytokenSet('s', [], ['delete_account']);
    expect(matchPhantomTool(set, 'delete_account')).toEqual({
      kind: 'phantom_tool',
      toolName: 'delete_account',
    });
  });

  it('does not match a different name', () => {
    const set = defineHoneytokenSet('s', [], ['delete_account']);
    expect(matchPhantomTool(set, 'read_file')).toBeNull();
  });

  it('returns null when no phantom tools registered', () => {
    const set = defineHoneytokenSet('s', [{ id: 'k', value: 'x' }]);
    expect(matchPhantomTool(set, 'anything')).toBeNull();
  });

  it('returns null when phantomTools field is undefined (manual set)', () => {
    // Bypass defineHoneytokenSet — exercise the undefined branch.
    const manual = {
      id: 's',
      tokens: [{ id: 'k', value: 'x' }],
    };
    expect(matchPhantomTool(manual, 'whatever')).toBeNull();
  });
});

describe('checkHoneytoken', () => {
  it('phantom-tool match wins over value-in-args', () => {
    const set = defineHoneytokenSet(
      's',
      [{ id: 'val', value: 'collide' }],
      ['phantom_tool'],
    );
    // Args contain the value too — but phantom should win.
    expect(checkHoneytoken(set, 'phantom_tool', { x: 'collide' })).toEqual({
      kind: 'phantom_tool',
      toolName: 'phantom_tool',
    });
  });

  it('falls through to value match when tool name is normal', () => {
    const set = defineHoneytokenSet('s', [{ id: 'val', value: 'collide' }], ['phantom']);
    expect(checkHoneytoken(set, 'normal_tool', { x: 'collide' })).toEqual({
      kind: 'value_in_args',
      tokenId: 'val',
    });
  });

  it('returns null when neither fires', () => {
    const set = defineHoneytokenSet('s', [{ id: 'val', value: 'shouldnt' }], ['phantom']);
    expect(checkHoneytoken(set, 'normal_tool', { x: 'fine' })).toBeNull();
  });
});

describe('GuardianRuntime + honeytokens', () => {
  it('value-in-args triggers E-stop + audit row + throw', async () => {
    const path = join(tmp, 'audit.jsonl');
    const audit = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const estop = new EStopLocal({ audit });
    const set = defineHoneytokenSet('s', [{ id: 'fake-key', value: 'fd_honey_xyz' }]);
    const rt = new GuardianRuntime({
      agentId: 'a',
      sessionId: 's',
      audit,
      estop,
      honeytokens: set,
    });
    const t = rt.tool(async () => 'should not run', { name: 'probe' });
    await expect(t({ creds: 'fd_honey_xyz' })).rejects.toBeInstanceOf(GuardianHaltedError);
    await rt.close();

    const recs = await readAll(path);
    const hit = recs.find((r) => r.kind === ('x_honeytoken_triggered' as unknown));
    expect(hit).toBeDefined();
    expect(hit?.status).toBe('halted');
    expect(hit?.detail?.token_id).toBe('fake-key');
    expect(estop.isPressed()).toBe(true);
  });

  it('phantom-tool name triggers immediately', async () => {
    const path = join(tmp, 'audit.jsonl');
    const audit = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const estop = new EStopLocal({ audit });
    const set = defineHoneytokenSet('s', [], ['delete_account_unsafe']);
    const rt = new GuardianRuntime({ agentId: 'a', sessionId: 's', audit, estop, honeytokens: set });
    const t = rt.tool(async () => 'never', { name: 'delete_account_unsafe' });
    await expect(t({ ok: 'fine' })).rejects.toBeInstanceOf(GuardianHaltedError);
    await rt.close();

    const recs = await readAll(path);
    const hit = recs.find((r) => r.kind === ('x_honeytoken_triggered' as unknown));
    expect(hit?.detail?.hit_kind).toBe('phantom_tool');
    expect(hit?.detail?.tool_name).toBe('delete_account_unsafe');
  });

  it('throws but does not press EStop when runtime has no EStop configured', async () => {
    const path = join(tmp, 'audit.jsonl');
    const audit = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const set = defineHoneytokenSet('s', [{ id: 'k', value: 'TRIPME' }]);
    const rt = new GuardianRuntime({ agentId: 'a', sessionId: 's', audit, honeytokens: set });
    const t = rt.tool(async () => 'no', { name: 'x' });
    await expect(t({ a: 'TRIPME' })).rejects.toBeInstanceOf(GuardianHaltedError);
    await rt.close();
    const recs = await readAll(path);
    expect(recs.some((r) => r.kind === ('x_honeytoken_triggered' as unknown))).toBe(true);
  });

  it('no honeytoken set → normal dispatch flow unaffected', async () => {
    const path = join(tmp, 'audit.jsonl');
    const audit = new AuditLogWriter({ path, agentId: 'a', sessionId: 's' });
    const rt = new GuardianRuntime({ agentId: 'a', sessionId: 's', audit });
    const t = rt.tool(async () => 'ok', { name: 'x' });
    await expect(t({ creds: 'looks_suspicious_but_no_set' })).resolves.toBe('ok');
    await rt.close();
    const recs = await readAll(path);
    expect(recs.some((r) => r.kind === ('x_honeytoken_triggered' as unknown))).toBe(false);
  });
});
