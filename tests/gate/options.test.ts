import { describe, expect, it } from 'vitest';

import {
  CLASSIC_FOUR,
  FLOWDOT_FIVE,
  defineGateOptionSet,
  findOption,
  resolveOption,
} from '../../src/gate/options.js';

describe('FLOWDOT_FIVE', () => {
  it('has 5 options in declaration order', () => {
    expect(FLOWDOT_FIVE.options.map((o) => o.id)).toEqual([
      'once',
      'session',
      'tool',
      'toolkit',
      'deny',
    ]);
  });

  it('maps once/session/tool to allow with correct scopes', () => {
    expect(findOption(FLOWDOT_FIVE, 'once')).toMatchObject({
      scope: 'once',
      decision: 'allow',
      granularity: 'tool',
    });
    expect(findOption(FLOWDOT_FIVE, 'session')).toMatchObject({
      scope: 'session',
      decision: 'allow',
    });
    expect(findOption(FLOWDOT_FIVE, 'tool')).toMatchObject({
      scope: 'forever',
      decision: 'allow',
      granularity: 'tool',
    });
  });

  it('maps toolkit to forever-allow at toolkit granularity', () => {
    expect(findOption(FLOWDOT_FIVE, 'toolkit')).toMatchObject({
      scope: 'forever',
      decision: 'allow',
      granularity: 'toolkit',
    });
  });

  it('maps deny to once-deny', () => {
    expect(findOption(FLOWDOT_FIVE, 'deny')).toMatchObject({
      scope: 'once',
      decision: 'deny',
    });
  });
});

describe('CLASSIC_FOUR', () => {
  it('has the four classic file-permission scopes', () => {
    expect(CLASSIC_FOUR.options.map((o) => o.id)).toEqual([
      'once',
      'session',
      'forever',
      'banned',
    ]);
  });

  it('maps banned to deny-with-banned-scope', () => {
    expect(findOption(CLASSIC_FOUR, 'banned')).toMatchObject({
      scope: 'banned',
      decision: 'deny',
    });
  });
});

describe('defineGateOptionSet', () => {
  it('builds a custom set', () => {
    const set = defineGateOptionSet(
      'two-button',
      [
        { id: 'go', scope: 'once', decision: 'allow' },
        { id: 'stop', scope: 'once', decision: 'deny' },
      ],
      'minimal yes/no',
    );
    expect(set.id).toBe('two-button');
    expect(set.options).toHaveLength(2);
    expect(set.description).toBe('minimal yes/no');
  });

  it('omits description when not provided', () => {
    const set = defineGateOptionSet('x', [{ id: 'a', scope: 'once', decision: 'allow' }]);
    expect(set.description).toBeUndefined();
  });

  it('rejects empty option list', () => {
    expect(() => defineGateOptionSet('empty', [])).toThrow(/non-empty/);
  });

  it('rejects duplicate ids', () => {
    expect(() =>
      defineGateOptionSet('dup', [
        { id: 'a', scope: 'once', decision: 'allow' },
        { id: 'a', scope: 'session', decision: 'allow' },
      ]),
    ).toThrow(/duplicate/);
  });
});

describe('findOption', () => {
  it('returns undefined for unknown id', () => {
    expect(findOption(FLOWDOT_FIVE, 'unknown')).toBeUndefined();
  });
});

describe('resolveOption', () => {
  it('returns the option when id matches', () => {
    const opt = resolveOption(FLOWDOT_FIVE, 'session');
    expect(opt.id).toBe('session');
  });

  it('throws with valid ids listed when id does not match', () => {
    expect(() => resolveOption(FLOWDOT_FIVE, 'sometimes')).toThrow(
      /Unknown gate option .* once, session, tool, toolkit, deny/,
    );
  });
});
