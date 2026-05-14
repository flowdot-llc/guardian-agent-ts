import { describe, expect, it } from 'vitest';

import { parsePolicy, validatePolicy } from '../../src/policy/loader.js';
import { GuardianConfigError } from '../../src/errors.js';

describe('parsePolicy', () => {
  it('parses a minimal valid policy', () => {
    const p = parsePolicy(`
version: "0.2"
agent_id: "agent_a"
defaults:
  scope: prompt
rules: []
`);
    expect(p.version).toBe('0.2');
    expect(p.agent_id).toBe('agent_a');
    expect(p.defaults.scope).toBe('prompt');
    expect(p.rules).toHaveLength(0);
  });

  it('parses rules in order', () => {
    const p = parsePolicy(`
version: "0.2"
agent_id: "a"
defaults: { scope: prompt }
rules:
  - tool: "filesystem.read"
    scope: forever
    decision: allow
  - tool: "filesystem.write"
    scope: banned
  - tool: "x.*"
    scope: session
    decision: allow
    notes: "wildcard"
`);
    expect(p.rules).toHaveLength(3);
    expect(p.rules[0]?.tool).toBe('filesystem.read');
    expect(p.rules[1]?.scope).toBe('banned');
    expect(p.rules[2]?.notes).toBe('wildcard');
  });

  it('accepts defaults.decision', () => {
    const p = parsePolicy(`
version: "0.2"
agent_id: "a"
defaults:
  scope: forever
  decision: allow
rules: []
`);
    expect(p.defaults.decision).toBe('allow');
  });
});

describe('validatePolicy (rejection paths)', () => {
  it('rejects non-object root', () => {
    expect(() => validatePolicy('hello')).toThrow(GuardianConfigError);
    expect(() => validatePolicy(null)).toThrow(GuardianConfigError);
    expect(() => validatePolicy(['a'])).toThrow(GuardianConfigError);
  });

  it('rejects missing version', () => {
    expect(() => validatePolicy({ agent_id: 'a', defaults: { scope: 'prompt' } })).toThrow(
      /version/,
    );
  });

  it('rejects missing agent_id', () => {
    expect(() => validatePolicy({ version: '0.2', defaults: { scope: 'prompt' } })).toThrow(
      /agent_id/,
    );
  });

  it('rejects missing defaults', () => {
    expect(() => validatePolicy({ version: '0.2', agent_id: 'a' })).toThrow(/defaults/);
  });

  it('rejects bad defaults.scope', () => {
    expect(() =>
      validatePolicy({ version: '0.2', agent_id: 'a', defaults: { scope: 'nope' } }),
    ).toThrow(/defaults.scope/);
  });

  it('rejects bad defaults.decision', () => {
    expect(() =>
      validatePolicy({
        version: '0.2',
        agent_id: 'a',
        defaults: { scope: 'prompt', decision: 'maybe' },
      }),
    ).toThrow(/defaults.decision/);
  });

  it('rejects non-array rules', () => {
    expect(() =>
      validatePolicy({
        version: '0.2',
        agent_id: 'a',
        defaults: { scope: 'prompt' },
        rules: 'oops',
      }),
    ).toThrow(/rules/);
  });

  it('rejects non-object rule', () => {
    expect(() =>
      validatePolicy({
        version: '0.2',
        agent_id: 'a',
        defaults: { scope: 'prompt' },
        rules: ['oops'],
      }),
    ).toThrow(/rule\[0\]/);
  });

  it('rejects rule with missing tool', () => {
    expect(() =>
      validatePolicy({
        version: '0.2',
        agent_id: 'a',
        defaults: { scope: 'prompt' },
        rules: [{ scope: 'session' }],
      }),
    ).toThrow(/tool/);
  });

  it('rejects rule with bad scope', () => {
    expect(() =>
      validatePolicy({
        version: '0.2',
        agent_id: 'a',
        defaults: { scope: 'prompt' },
        rules: [{ tool: 't', scope: 'oops' }],
      }),
    ).toThrow(/scope/);
  });

  it('rejects rule with reserved prefix', () => {
    expect(() =>
      validatePolicy({
        version: '0.2',
        agent_id: 'a',
        defaults: { scope: 'prompt' },
        rules: [{ tool: 'guardian.foo', scope: 'session' }],
      }),
    ).toThrow(/reserved/);
  });

  it('rejects rule with bad decision', () => {
    expect(() =>
      validatePolicy({
        version: '0.2',
        agent_id: 'a',
        defaults: { scope: 'prompt' },
        rules: [{ tool: 't', scope: 'session', decision: 'oops' }],
      }),
    ).toThrow(/decision/);
  });

  it('rejects rule with non-string notes', () => {
    expect(() =>
      validatePolicy({
        version: '0.2',
        agent_id: 'a',
        defaults: { scope: 'prompt' },
        rules: [{ tool: 't', scope: 'session', notes: 7 }],
      }),
    ).toThrow(/notes/);
  });

  it('accepts a rule with when clause', () => {
    const p = validatePolicy({
      version: '0.2',
      agent_id: 'a',
      defaults: { scope: 'prompt' },
      rules: [
        {
          tool: 't',
          scope: 'forever',
          decision: 'allow',
          when: { 'model.provider': 'anthropic', 'model.id': 'claude-*-4.5*' },
        },
      ],
    });
    expect(p.rules[0]?.when?.['model.provider']).toBe('anthropic');
    expect(p.rules[0]?.when?.['model.id']).toBe('claude-*-4.5*');
  });

  it('rejects non-object when', () => {
    expect(() =>
      validatePolicy({
        version: '0.2',
        agent_id: 'a',
        defaults: { scope: 'prompt' },
        rules: [{ tool: 't', scope: 'session', when: 7 }],
      }),
    ).toThrow(/when/);
  });

  it('rejects non-string model.provider in when', () => {
    expect(() =>
      validatePolicy({
        version: '0.2',
        agent_id: 'a',
        defaults: { scope: 'prompt' },
        rules: [{ tool: 't', scope: 'session', when: { 'model.provider': 7 } }],
      }),
    ).toThrow(/model.provider/);
  });

  it('rejects non-string model.id in when', () => {
    expect(() =>
      validatePolicy({
        version: '0.2',
        agent_id: 'a',
        defaults: { scope: 'prompt' },
        rules: [{ tool: 't', scope: 'session', when: { 'model.id': 7 } }],
      }),
    ).toThrow(/model.id/);
  });

  it('accepts a rule without optional fields', () => {
    const p = validatePolicy({
      version: '0.2',
      agent_id: 'a',
      defaults: { scope: 'prompt' },
      rules: [{ tool: 't', scope: 'session' }],
    });
    expect(p.rules[0]?.decision).toBeUndefined();
    expect(p.rules[0]?.notes).toBeUndefined();
  });
});
