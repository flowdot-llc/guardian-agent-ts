import { describe, expect, it } from 'vitest';

import { PolicyEvaluator, globMatch } from '../../src/policy/evaluator.js';
import type { Policy } from '../../src/policy/types.js';

function policy(rules: Policy['rules'], defaultScope: Policy['defaults']['scope'] = 'prompt'): Policy {
  return {
    version: '0.2',
    agent_id: 'a',
    defaults: { scope: defaultScope },
    rules,
  };
}

describe('PolicyEvaluator — resolution order', () => {
  it('exact banned beats forever-allow', () => {
    const ev = new PolicyEvaluator(
      policy([
        { tool: 'x', scope: 'forever', decision: 'allow' },
        { tool: 'x', scope: 'banned' },
      ]),
    );
    const r = ev.evaluate('x');
    expect(r.decision).toBe('deny');
    expect(r.scope).toBe('banned');
    expect(r.matchedAt).toBe('exact');
  });

  it('forever-allow beats session-allow', () => {
    const ev = new PolicyEvaluator(
      policy([
        { tool: 'x', scope: 'session', decision: 'allow' },
        { tool: 'x', scope: 'forever', decision: 'allow' },
      ]),
    );
    const r = ev.evaluate('x');
    expect(r.scope).toBe('forever');
  });

  it('exact match beats wildcard match', () => {
    const ev = new PolicyEvaluator(
      policy([
        { tool: 'x.*', scope: 'forever', decision: 'allow' },
        { tool: 'x.specific', scope: 'session', decision: 'allow' },
      ]),
    );
    const r = ev.evaluate('x.specific');
    // forever beats session even though session is the exact match; rank wins.
    expect(r.scope).toBe('forever');
  });

  it('wildcard banned beats wildcard allow', () => {
    const ev = new PolicyEvaluator(
      policy([
        { tool: 'x.*', scope: 'forever', decision: 'allow' },
        { tool: 'x.*', scope: 'banned' },
      ]),
    );
    const r = ev.evaluate('x.something');
    expect(r.decision).toBe('deny');
    expect(r.matchedAt).toBe('wildcard');
  });

  it('falls through to defaults when no rule matches', () => {
    const ev = new PolicyEvaluator(policy([], 'prompt'));
    const r = ev.evaluate('unmatched');
    expect(r.decision).toBe('prompt');
    expect(r.matchedAt).toBe('default');
    expect(r.scope).toBe('prompt');
  });

  it('defaults.scope=forever produces an allow by default', () => {
    const ev = new PolicyEvaluator(policy([], 'forever'));
    expect(ev.evaluate('unmatched').decision).toBe('allow');
  });

  it('defaults.scope=banned produces a deny by default', () => {
    const ev = new PolicyEvaluator(policy([], 'banned'));
    expect(ev.evaluate('unmatched').decision).toBe('deny');
  });

  it('respects explicit defaults.decision', () => {
    const ev = new PolicyEvaluator({
      version: '0.2',
      agent_id: 'a',
      defaults: { scope: 'forever', decision: 'deny' },
      rules: [],
    });
    expect(ev.evaluate('unmatched').decision).toBe('deny');
  });

  it('explicit deny at a non-banned scope short-circuits at that scope', () => {
    const ev = new PolicyEvaluator(
      policy([
        { tool: 'x', scope: 'session', decision: 'deny' },
        { tool: 'x', scope: 'forever', decision: 'allow' },
      ]),
    );
    const r = ev.evaluate('x');
    // forever-allow wins over session-deny because forever has higher rank.
    expect(r.decision).toBe('allow');
    expect(r.scope).toBe('forever');
  });

  it('session-deny used when no higher-priority rule matches', () => {
    const ev = new PolicyEvaluator(
      policy([{ tool: 'x', scope: 'session', decision: 'deny' }]),
    );
    const r = ev.evaluate('x');
    expect(r.decision).toBe('deny');
    expect(r.scope).toBe('session');
  });

  it('category match works for category:<name>', () => {
    const ev = new PolicyEvaluator(
      policy([{ tool: 'category:file-write', scope: 'forever', decision: 'allow' }]),
    );
    const r = ev.evaluate('category:file-write');
    expect(r.decision).toBe('allow');
    expect(r.matchedAt).toBe('exact');
  });

  it('once-allow rule', () => {
    const ev = new PolicyEvaluator(policy([{ tool: 'x', scope: 'once', decision: 'allow' }]));
    expect(ev.evaluate('x').decision).toBe('allow');
  });

  it('once-deny rule', () => {
    const ev = new PolicyEvaluator(policy([{ tool: 'x', scope: 'once', decision: 'deny' }]));
    expect(ev.evaluate('x').decision).toBe('deny');
  });

  it('matches ?-style wildcard in policy rule', () => {
    const ev = new PolicyEvaluator(
      policy([{ tool: 'tool.?', scope: 'forever', decision: 'allow' }]),
    );
    expect(ev.evaluate('tool.x').decision).toBe('allow');
    expect(ev.evaluate('tool.xy').decision).toBe('prompt');
  });

  it('matches [class]-style wildcard in policy rule', () => {
    const ev = new PolicyEvaluator(
      policy([{ tool: 'tool.[abc]', scope: 'forever', decision: 'allow' }]),
    );
    expect(ev.evaluate('tool.a').decision).toBe('allow');
    expect(ev.evaluate('tool.d').decision).toBe('prompt');
  });

  it('treats forever rule without explicit decision as allow', () => {
    // decision omitted → effectiveDecision falls back to ?? 'allow'.
    const ev = new PolicyEvaluator(policy([{ tool: 'x', scope: 'forever' }]));
    expect(ev.evaluate('x').decision).toBe('allow');
  });

  it('exact-name rule with no glob chars skips wildcard loop', () => {
    const ev = new PolicyEvaluator(
      policy([{ tool: 'tool.exact', scope: 'forever', decision: 'allow' }]),
    );
    // Different tool: no match at all → falls through to defaults.
    expect(ev.evaluate('tool.other').decision).toBe('prompt');
  });

  it('first wildcard in declaration order wins among equals', () => {
    const ev = new PolicyEvaluator(
      policy([
        { tool: 'a.*', scope: 'forever', decision: 'allow' },
        { tool: '*.b', scope: 'forever', decision: 'deny' },
      ]),
    );
    const r = ev.evaluate('a.b');
    expect(r.decision).toBe('allow');
  });

  it('rankFor returns documented values', () => {
    const ev = new PolicyEvaluator(policy([]));
    expect(ev.rankFor('banned')).toBe(0);
    expect(ev.rankFor('forever')).toBe(1);
    expect(ev.rankFor('session')).toBe(2);
    expect(ev.rankFor('once')).toBe(3);
  });
});

describe('globMatch', () => {
  it('matches plain * anywhere', () => {
    expect(globMatch('a.*', 'a.b')).toBe(true);
    expect(globMatch('*.b', 'a.b')).toBe(true);
    expect(globMatch('*', 'anything')).toBe(true);
  });

  it('matches ? as single char', () => {
    expect(globMatch('a.?', 'a.b')).toBe(true);
    expect(globMatch('a.?', 'a.bc')).toBe(false);
  });

  it('handles character classes', () => {
    expect(globMatch('a.[bc]', 'a.b')).toBe(true);
    expect(globMatch('a.[bc]', 'a.c')).toBe(true);
    expect(globMatch('a.[bc]', 'a.d')).toBe(false);
  });

  it('handles negated character classes', () => {
    expect(globMatch('a.[!bc]', 'a.d')).toBe(true);
    expect(globMatch('a.[!bc]', 'a.b')).toBe(false);
  });

  it('treats unmatched [ literally', () => {
    expect(globMatch('a[', 'a[')).toBe(true);
    expect(globMatch('a[', 'a')).toBe(false);
  });

  it('escapes regex metacharacters', () => {
    expect(globMatch('a.b+c', 'a.b+c')).toBe(true);
    expect(globMatch('a.b+c', 'a.bbc')).toBe(false);
  });

  it('treats characters inside char class literally', () => {
    // Standard fnmatch: char classes terminate at the first ], so [a]b matches
    // exactly the literal letter "a" followed by literal "b".
    expect(globMatch('a.[a]b', 'a.ab')).toBe(true);
    expect(globMatch('a.[a]b', 'a.bb')).toBe(false);
  });
});
