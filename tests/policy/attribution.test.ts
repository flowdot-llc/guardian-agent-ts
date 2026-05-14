import { describe, expect, it } from 'vitest';

import {
  flatGlobMatch,
  matchAttributionPath,
  renderAttributionPath,
} from '../../src/policy/attribution.js';

describe('renderAttributionPath', () => {
  it('renders all four fields when present', () => {
    expect(
      renderAttributionPath({
        surface: 'FlowDot',
        aggregator: 'RedPill',
        provider: 'Anthropic',
        id: 'claude-opus-4.5',
      }),
    ).toBe('FlowDot/RedPill/Anthropic/claude-opus-4.5');
  });

  it('substitutes * for missing surface and aggregator (legacy 2-field attribution)', () => {
    expect(
      renderAttributionPath({ provider: 'Anthropic', id: 'claude-opus-4.5' }),
    ).toBe('*/*/Anthropic/claude-opus-4.5');
  });

  it('substitutes * for missing aggregator only', () => {
    expect(
      renderAttributionPath({ surface: 'FlowDot', provider: 'OpenAI', id: 'gpt-5' }),
    ).toBe('FlowDot/*/OpenAI/gpt-5');
  });

  it('substitutes * for missing surface only', () => {
    expect(
      renderAttributionPath({ aggregator: 'OpenRouter', provider: 'OpenAI', id: 'gpt-5' }),
    ).toBe('*/OpenRouter/OpenAI/gpt-5');
  });
});

describe('matchAttributionPath', () => {
  const full = {
    surface: 'FlowDot',
    aggregator: 'RedPill',
    provider: 'Anthropic',
    id: 'claude-opus-4.5',
  };

  it('exact match', () => {
    expect(matchAttributionPath('FlowDot/RedPill/Anthropic/claude-opus-4.5', full)).toBe(true);
  });

  it('does not match a different model id', () => {
    expect(matchAttributionPath('FlowDot/RedPill/Anthropic/claude-opus-4.6', full)).toBe(false);
  });

  it('substring-style wildcard matches across segments (* spans /)', () => {
    expect(matchAttributionPath('*claude-opus*', full)).toBe(true);
  });

  it('aggregator-only constraint', () => {
    expect(matchAttributionPath('*/RedPill/*/*', full)).toBe(true);
    expect(
      matchAttributionPath('*/RedPill/*/*', {
        surface: 'FlowDot',
        aggregator: 'OpenRouter',
        provider: 'Anthropic',
        id: 'claude-opus-4.5',
      }),
    ).toBe(false);
  });

  it('provider-only constraint', () => {
    expect(matchAttributionPath('*/*/Anthropic/*', full)).toBe(true);
    expect(
      matchAttributionPath('*/*/Anthropic/*', {
        provider: 'OpenAI',
        id: 'gpt-5',
      }),
    ).toBe(false);
  });

  it('model family glob across providers', () => {
    expect(
      matchAttributionPath('*/*/*/claude-*-4.*', {
        provider: 'Anthropic',
        id: 'claude-opus-4.5',
      }),
    ).toBe(true);
    expect(
      matchAttributionPath('*/*/*/claude-*-4.*', {
        provider: 'Anthropic',
        id: 'claude-haiku-4.5',
      }),
    ).toBe(true);
    expect(
      matchAttributionPath('*/*/*/claude-*-4.*', {
        provider: 'Anthropic',
        id: 'claude-opus-3.5',
      }),
    ).toBe(false);
  });

  it('matches legacy 2-field attribution via wildcard surface/aggregator', () => {
    expect(
      matchAttributionPath('*/*/Anthropic/claude-opus-4.5', {
        provider: 'Anthropic',
        id: 'claude-opus-4.5',
      }),
    ).toBe(true);
  });

  it('does not match when the literal pattern requires a surface but attribution lacks one', () => {
    // legacy attribution renders surface as `*`. A literal pattern that names
    // a specific surface won't match because `*` ≠ `FlowDot` under exact
    // comparison.
    expect(
      matchAttributionPath('FlowDot/*/Anthropic/claude-opus-4.5', {
        provider: 'Anthropic',
        id: 'claude-opus-4.5',
      }),
    ).toBe(false);
  });
});

describe('flatGlobMatch', () => {
  it('? matches exactly one character including /', () => {
    expect(flatGlobMatch('a?c', 'a/c')).toBe(true);
    expect(flatGlobMatch('a?c', 'ac')).toBe(false);
    expect(flatGlobMatch('a?c', 'abbc')).toBe(false);
  });

  it('character class', () => {
    expect(flatGlobMatch('claude-[oh]pus', 'claude-opus')).toBe(true);
    expect(flatGlobMatch('claude-[oh]pus', 'claude-hpus')).toBe(true);
    expect(flatGlobMatch('claude-[oh]pus', 'claude-xpus')).toBe(false);
  });

  it('negated character class', () => {
    expect(flatGlobMatch('claude-[!o]pus', 'claude-hpus')).toBe(true);
    expect(flatGlobMatch('claude-[!o]pus', 'claude-opus')).toBe(false);
  });

  it('escapes regex specials in literal segments', () => {
    expect(flatGlobMatch('claude-opus-4.5', 'claude-opus-4.5')).toBe(true);
    // `.` in pattern is literal, not regex any-char
    expect(flatGlobMatch('claude-opus-4.5', 'claude-opus-4x5')).toBe(false);
  });

  it('unmatched [ is treated literally', () => {
    expect(flatGlobMatch('a[bc', 'a[bc')).toBe(true);
    expect(flatGlobMatch('a[bc', 'abc')).toBe(false);
  });

  it('anchors at both ends', () => {
    expect(flatGlobMatch('claude', 'claude-opus-4.5')).toBe(false);
    expect(flatGlobMatch('claude*', 'claude-opus-4.5')).toBe(true);
    expect(flatGlobMatch('*-4.5', 'claude-opus-4.5')).toBe(true);
  });
});
