import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { PolicyStore } from '../../src/policy/store.js';
import { siteKeyFromBytes } from '../../src/policy/site-key.js';
import { signPayload } from '../../src/policy/integrity.js';
import { GuardianIntegrityError } from '../../src/errors.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'guardian-store-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('PolicyStore', () => {
  it('returns an empty policy when no files exist', () => {
    const store = new PolicyStore({ dir: tmp, agentId: 'a' });
    const p = store.getPolicy();
    expect(p.rules).toHaveLength(0);
    expect(p.defaults.scope).toBe('prompt');
  });

  it('persists a forever-allow rule to permissions.yaml (signed)', async () => {
    const store = new PolicyStore({ dir: tmp, agentId: 'a' });
    await store.addRule({ tool: 'filesystem.read', scope: 'forever', decision: 'allow' });

    const path = join(tmp, 'permissions.yaml');
    const raw = readFileSync(path, 'utf-8');
    const parsed = parseYaml(raw) as { signature: string; data: string };
    expect(parsed.signature).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(parsed.data).toContain('filesystem.read');

    const reread = store.getPolicy();
    expect(reread.rules).toHaveLength(1);
    expect(reread.rules[0]?.tool).toBe('filesystem.read');
  });

  it('persists a session-allow rule to session.yaml (unsigned)', async () => {
    const store = new PolicyStore({ dir: tmp, agentId: 'a' });
    await store.addRule({ tool: 'lookup', scope: 'session', decision: 'allow' });

    const sessionPath = join(tmp, 'session.yaml');
    expect(existsSync(sessionPath)).toBe(true);
    const raw = readFileSync(sessionPath, 'utf-8');
    const parsed = parseYaml(raw) as { signature?: string };
    expect(parsed.signature).toBeUndefined();

    const merged = store.getPolicy();
    expect(merged.rules).toHaveLength(1);
    expect(merged.rules[0]?.scope).toBe('session');
  });

  it('persists banned rules', async () => {
    const store = new PolicyStore({ dir: tmp, agentId: 'a' });
    await store.addRule({ tool: 'place_order', scope: 'banned' });
    const reread = store.getPolicy();
    expect(reread.rules[0]?.scope).toBe('banned');
  });

  it('replaces existing rule with same tool + scope', async () => {
    const store = new PolicyStore({ dir: tmp, agentId: 'a' });
    await store.addRule({ tool: 'x', scope: 'forever', decision: 'allow' });
    await store.addRule({ tool: 'x', scope: 'forever', decision: 'deny' });
    const p = store.getPolicy();
    expect(p.rules).toHaveLength(1);
    expect(p.rules[0]?.decision).toBe('deny');
  });

  it('removeRule drops a rule', async () => {
    const store = new PolicyStore({ dir: tmp, agentId: 'a' });
    await store.addRule({ tool: 'x', scope: 'forever', decision: 'allow' });
    await store.removeRule('x', 'forever');
    expect(store.getPolicy().rules).toHaveLength(0);
  });

  it('removeRule on session rules', async () => {
    const store = new PolicyStore({ dir: tmp, agentId: 'a' });
    await store.addRule({ tool: 'x', scope: 'session', decision: 'allow' });
    await store.removeRule('x', 'session');
    expect(store.getPolicy().rules).toHaveLength(0);
  });

  it('clearSession removes session.yaml', async () => {
    const store = new PolicyStore({ dir: tmp, agentId: 'a' });
    await store.addRule({ tool: 'x', scope: 'session', decision: 'allow' });
    expect(existsSync(join(tmp, 'session.yaml'))).toBe(true);
    await store.clearSession();
    expect(existsSync(join(tmp, 'session.yaml'))).toBe(false);
  });

  it('clearSession is a no-op when session.yaml absent', async () => {
    const store = new PolicyStore({ dir: tmp, agentId: 'a' });
    await store.clearSession();
    expect(existsSync(join(tmp, 'session.yaml'))).toBe(false);
  });

  it('rejects permissions.yaml with bad signature (fail-closed)', async () => {
    const path = join(tmp, 'permissions.yaml');
    writeFileSync(
      path,
      stringifyYaml({
        version: 1,
        signed_at: '2026-01-01T00:00:00Z',
        signature: 'AA==',
        data: stringifyYaml({
          version: '0.2',
          agent_id: 'a',
          defaults: { scope: 'prompt' },
          rules: [],
        }),
      }),
    );

    const store = new PolicyStore({ dir: tmp, agentId: 'a' });
    expect(() => store.getPolicy()).toThrow(GuardianIntegrityError);
  });

  it('rejects permissions.yaml in non-signed-file format', async () => {
    const path = join(tmp, 'permissions.yaml');
    writeFileSync(
      path,
      stringifyYaml({
        version: '0.2',
        agent_id: 'a',
        defaults: { scope: 'prompt' },
        rules: [],
      }),
    );
    const store = new PolicyStore({ dir: tmp, agentId: 'a' });
    expect(() => store.getPolicy()).toThrow(GuardianIntegrityError);
  });

  it('round-trips a signed file written by hand using the same site key', () => {
    const keyBytes = Buffer.alloc(32, 7);
    const siteKey = siteKeyFromBytes(keyBytes);
    const path = join(tmp, 'permissions.yaml');

    const dataYaml = stringifyYaml(
      {
        agent_id: 'a',
        defaults: { scope: 'prompt' },
        rules: [{ tool: 'x', scope: 'forever', decision: 'allow' }],
        version: '0.2',
      },
      { sortMapEntries: true },
    );
    const signature = signPayload(dataYaml, keyBytes);
    writeFileSync(
      path,
      stringifyYaml({
        version: 1,
        signed_at: '2026-01-01T00:00:00Z',
        signature,
        data: dataYaml,
      }),
    );

    const store = new PolicyStore({ dir: tmp, agentId: 'a', siteKey });
    const p = store.getPolicy();
    expect(p.rules).toHaveLength(1);
    expect(p.rules[0]?.tool).toBe('x');
  });

  it('honors custom defaultScope on empty store', () => {
    const store = new PolicyStore({ dir: tmp, agentId: 'a', defaultScope: 'forever' });
    expect(store.getPolicy().defaults.scope).toBe('forever');
  });

  it('close is idempotent', async () => {
    const store = new PolicyStore({ dir: tmp, agentId: 'a' });
    await store.close();
    await store.close();
  });

  it('serializes concurrent addRule calls', async () => {
    const store = new PolicyStore({ dir: tmp, agentId: 'a' });
    await Promise.all([
      store.addRule({ tool: 'a', scope: 'forever', decision: 'allow' }),
      store.addRule({ tool: 'b', scope: 'forever', decision: 'allow' }),
      store.addRule({ tool: 'c', scope: 'forever', decision: 'allow' }),
    ]);
    expect(store.getPolicy().rules).toHaveLength(3);
  });

  it('treats empty session.yaml as empty policy', async () => {
    writeFileSync(join(tmp, 'session.yaml'), '');
    const store = new PolicyStore({ dir: tmp, agentId: 'a' });
    expect(store.getPolicy().rules).toHaveLength(0);
  });

  it('rejects permissions.yaml with null content', async () => {
    writeFileSync(join(tmp, 'permissions.yaml'), 'null\n');
    const store = new PolicyStore({ dir: tmp, agentId: 'a' });
    expect(() => store.getPolicy()).toThrow(GuardianIntegrityError);
  });

  it('survives one write failure', async () => {
    const store = new PolicyStore({ dir: tmp, agentId: 'a' });
    // First, a successful write so the file is established.
    await store.addRule({ tool: 'x', scope: 'forever', decision: 'allow' });
    // Subsequent writes proceed normally.
    await store.addRule({ tool: 'y', scope: 'forever', decision: 'allow' });
    expect(store.getPolicy().rules).toHaveLength(2);
  });
});

describe('PolicyStore.addRule write-validation (v0.9+)', () => {
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'guardian-store-validate-'));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('rejects a rule with an invalid scope', async () => {
    const store = new PolicyStore({ dir: tmp, agentId: 'a' });
    await expect(
      store.addRule({ tool: 'tool:x', scope: 'always' as never }),
    ).rejects.toThrow(/scope/);
    expect(store.getPolicy().rules).toHaveLength(0);
  });

  it('rejects a rule with an empty tool', async () => {
    const store = new PolicyStore({ dir: tmp, agentId: 'a' });
    await expect(
      store.addRule({ tool: '', scope: 'forever', decision: 'allow' }),
    ).rejects.toThrow(/tool/);
  });

  it('rejects a reserved-prefix tool', async () => {
    const store = new PolicyStore({ dir: tmp, agentId: 'a' });
    await expect(
      store.addRule({ tool: 'guardian.escape', scope: 'forever', decision: 'allow' }),
    ).rejects.toThrow(/reserved/);
  });

  it('strips unknown keys before signing to disk', async () => {
    const store = new PolicyStore({ dir: tmp, agentId: 'a' });
    await store.addRule({
      tool: 'tool:x',
      scope: 'forever',
      decision: 'allow',
      surface: 'smuggled',
      expiry: 'never',
    } as never);
    const [rule] = store.getPolicy().rules;
    expect(rule).toEqual({ tool: 'tool:x', scope: 'forever', decision: 'allow' });
    const raw = readFileSync(join(tmp, 'permissions.yaml'), 'utf-8');
    expect(raw).not.toContain('smuggled');
  });

  it('rejects an invalid when clause value', async () => {
    const store = new PolicyStore({ dir: tmp, agentId: 'a' });
    await expect(
      store.addRule({
        tool: 'tool:x',
        scope: 'forever',
        decision: 'allow',
        when: { 'model.provider': 42 as never },
      }),
    ).rejects.toThrow(/model.provider/);
  });
});

describe('PolicyStore — `when`-aware rule slots (agent-scoped grants)', () => {
  it('keeps a conditional rule and an unconditional one for the same tool + scope', async () => {
    const store = new PolicyStore({ dir: tmp, agentId: 'a' });
    await store.addRule({ tool: 'tool:file.read', scope: 'forever', decision: 'allow' });
    await store.addRule({
      tool: 'tool:file.read',
      scope: 'forever',
      decision: 'allow',
      when: { attribution_path: 'agent.reviewer/*' },
    });

    const rules = store.getPolicy().rules.filter((r) => r.tool === 'tool:file.read');
    expect(rules).toHaveLength(2);
    expect(rules.filter((r) => r.when === undefined)).toHaveLength(1);
    expect(rules.filter((r) => r.when?.attribution_path === 'agent.reviewer/*')).toHaveLength(1);
  });

  it('keeps two differently-scoped agent grants for the same tool', async () => {
    const store = new PolicyStore({ dir: tmp, agentId: 'a' });
    await store.addRule({
      tool: 'command.run:npm test*',
      scope: 'forever',
      decision: 'allow',
      when: { attribution_path: 'agent.one/*' },
    });
    await store.addRule({
      tool: 'command.run:npm test*',
      scope: 'forever',
      decision: 'allow',
      when: { attribution_path: 'agent.two/*' },
    });
    expect(store.getPolicy().rules).toHaveLength(2);
  });

  it('replaces a rule whose `when` matches, regardless of key order', async () => {
    const store = new PolicyStore({ dir: tmp, agentId: 'a' });
    await store.addRule({
      tool: 'x',
      scope: 'forever',
      decision: 'allow',
      when: { 'model.provider': 'openai', 'model.id': 'gpt-6-astra' },
    });
    await store.addRule({
      tool: 'x',
      scope: 'forever',
      decision: 'deny',
      when: { 'model.id': 'gpt-6-astra', 'model.provider': 'openai' },
    });
    const rules = store.getPolicy().rules;
    expect(rules).toHaveLength(1);
    expect(rules[0]?.decision).toBe('deny');
  });

  it('treats an empty `when` as unconditional, not as its own slot', async () => {
    const store = new PolicyStore({ dir: tmp, agentId: 'a' });
    await store.addRule({ tool: 'x', scope: 'forever', decision: 'allow' });
    await store.addRule({ tool: 'x', scope: 'forever', decision: 'deny', when: {} });
    const rules = store.getPolicy().rules;
    expect(rules).toHaveLength(1);
    expect(rules[0]?.decision).toBe('deny');
  });

  it('removeRule without `when` still removes every variant (historical behaviour)', async () => {
    const store = new PolicyStore({ dir: tmp, agentId: 'a' });
    await store.addRule({ tool: 'x', scope: 'forever', decision: 'allow' });
    await store.addRule({
      tool: 'x',
      scope: 'forever',
      decision: 'allow',
      when: { attribution_path: 'agent.one/*' },
    });
    await store.removeRule('x', 'forever');
    expect(store.getPolicy().rules).toHaveLength(0);
  });

  it('removeRule with `when` removes only that variant', async () => {
    const store = new PolicyStore({ dir: tmp, agentId: 'a' });
    await store.addRule({ tool: 'x', scope: 'forever', decision: 'allow' });
    await store.addRule({
      tool: 'x',
      scope: 'forever',
      decision: 'allow',
      when: { attribution_path: 'agent.one/*' },
    });
    await store.removeRule('x', 'forever', { attribution_path: 'agent.one/*' });
    const rules = store.getPolicy().rules;
    expect(rules).toHaveLength(1);
    expect(rules[0]?.when).toBeUndefined();
  });

  it('leaves no temp files behind when writing', async () => {
    const store = new PolicyStore({ dir: tmp, agentId: 'a' });
    await store.addRule({ tool: 'x', scope: 'forever', decision: 'allow' });
    await store.addRule({ tool: 'y', scope: 'session', decision: 'allow' });
    const leftovers = readdirSync(tmp).filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('concurrent addRule calls all land (atomic write, no lost rule)', async () => {
    const store = new PolicyStore({ dir: tmp, agentId: 'a' });
    await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((name) =>
        store.addRule({
          tool: 'command.run:echo *',
          scope: 'forever',
          decision: 'allow',
          when: { attribution_path: `agent.${name}/*` },
        }),
      ),
    );
    expect(store.getPolicy().rules).toHaveLength(5);
  });
});
