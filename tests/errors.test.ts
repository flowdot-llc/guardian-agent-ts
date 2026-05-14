import { describe, expect, it } from 'vitest';

import {
  GuardianConfigError,
  GuardianHaltedError,
  GuardianIntegrityError,
} from '../src/errors.js';

describe('GuardianHaltedError', () => {
  it('records reason and operatorId', () => {
    const e = new GuardianHaltedError('halt', 'manual', 'op_1');
    expect(e.name).toBe('GuardianHaltedError');
    expect(e.message).toBe('halt');
    expect(e.reason).toBe('manual');
    expect(e.operatorId).toBe('op_1');
    expect(e).toBeInstanceOf(Error);
  });

  it('accepts message only', () => {
    const e = new GuardianHaltedError('halt');
    expect(e.reason).toBeUndefined();
    expect(e.operatorId).toBeUndefined();
  });
});

describe('GuardianConfigError', () => {
  it('sets name', () => {
    const e = new GuardianConfigError('bad config');
    expect(e.name).toBe('GuardianConfigError');
    expect(e.message).toBe('bad config');
  });
});

describe('GuardianIntegrityError', () => {
  it('records optional detail', () => {
    const e = new GuardianIntegrityError('bad chain', 'expected x got y');
    expect(e.name).toBe('GuardianIntegrityError');
    expect(e.detail).toBe('expected x got y');
  });

  it('accepts message only', () => {
    const e = new GuardianIntegrityError('bad chain');
    expect(e.detail).toBeUndefined();
  });
});
