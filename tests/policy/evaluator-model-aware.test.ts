import { describe, expect, it } from 'vitest';

import { PolicyEvaluator } from '../../src/policy/evaluator.js';
import type { Policy } from '../../src/policy/types.js';
import type { ModelAttribution } from '../../src/types.js';

function p(rules: Policy['rules']): Policy {
  return {
    version: '0.2',
    agent_id: 'a',
    defaults: { scope: 'prompt' },
    rules,
  };
}

const claudeOpus: ModelAttribution = { provider: 'anthropic', id: 'claude-opus-4.5' };
const claudeSonnet45: ModelAttribution = { provider: 'anthropic', id: 'claude-sonnet-4.5' };
const claudeOpus4: ModelAttribution = { provider: 'anthropic', id: 'claude-opus-4' };
const gpt5: ModelAttribution = { provider: 'openai', id: 'gpt-5' };
const ollamaGemma: ModelAttribution = { provider: 'ollama', id: 'gemma3:12b' };

describe('PolicyEvaluator — model-aware rules', () => {
  it('rule with model.provider matches when provider matches', () => {
    const ev = new PolicyEvaluator(
      p([
        {
          tool: 'place_order',
          scope: 'forever',
          decision: 'deny',
          when: { 'model.provider': 'ollama' },
        },
      ]),
    );
    expect(ev.evaluate('place_order', ollamaGemma).decision).toBe('deny');
    expect(ev.evaluate('place_order', claudeOpus).decision).toBe('prompt');
  });

  it('rule with model.id glob matches', () => {
    const ev = new PolicyEvaluator(
      p([
        {
          tool: 'place_order',
          scope: 'forever',
          decision: 'allow',
          when: { 'model.id': 'claude-*-4.5*' },
        },
      ]),
    );
    expect(ev.evaluate('place_order', claudeOpus).decision).toBe('allow');
    expect(ev.evaluate('place_order', claudeSonnet45).decision).toBe('allow');
    expect(ev.evaluate('place_order', claudeOpus4).decision).toBe('prompt');
  });

  it('rule with both provider and id requires both to match', () => {
    const ev = new PolicyEvaluator(
      p([
        {
          tool: 'place_order',
          scope: 'forever',
          decision: 'allow',
          when: { 'model.provider': 'anthropic', 'model.id': 'claude-*-4.5*' },
        },
      ]),
    );
    expect(ev.evaluate('place_order', claudeOpus).decision).toBe('allow');
    // Wrong provider:
    expect(ev.evaluate('place_order', { ...claudeOpus, provider: 'fake' }).decision).toBe(
      'prompt',
    );
    // Right provider, wrong id:
    expect(ev.evaluate('place_order', claudeOpus4).decision).toBe('prompt');
  });

  it('rule with model.id-only when does not match when no model is supplied', () => {
    const ev = new PolicyEvaluator(
      p([
        {
          tool: 'place_order',
          scope: 'forever',
          decision: 'deny',
          when: { 'model.id': 'claude-*' },
        },
      ]),
    );
    expect(ev.evaluate('place_order').decision).toBe('prompt');
  });

  it('rule with when does not match when no model is supplied', () => {
    const ev = new PolicyEvaluator(
      p([
        {
          tool: 'place_order',
          scope: 'forever',
          decision: 'deny',
          when: { 'model.provider': 'ollama' },
        },
      ]),
    );
    expect(ev.evaluate('place_order').decision).toBe('prompt');
  });

  it('rule without when matches every model', () => {
    const ev = new PolicyEvaluator(
      p([{ tool: 'place_order', scope: 'forever', decision: 'allow' }]),
    );
    expect(ev.evaluate('place_order', gpt5).decision).toBe('allow');
    expect(ev.evaluate('place_order').decision).toBe('allow');
  });

  it('banned rule with when only fires for matching model', () => {
    const ev = new PolicyEvaluator(
      p([
        {
          tool: 'place_order',
          scope: 'banned',
          when: { 'model.provider': 'ollama' },
        },
      ]),
    );
    expect(ev.evaluate('place_order', ollamaGemma).decision).toBe('deny');
    expect(ev.evaluate('place_order', claudeOpus).decision).toBe('prompt');
  });

  it('combines tool-name wildcard with model-id wildcard', () => {
    const ev = new PolicyEvaluator(
      p([
        {
          tool: 'schwab_trading.*',
          scope: 'forever',
          decision: 'allow',
          when: { 'model.id': 'claude-*-4.5*' },
        },
      ]),
    );
    expect(ev.evaluate('schwab_trading.list_accounts', claudeOpus).decision).toBe('allow');
    expect(ev.evaluate('schwab_trading.list_accounts', claudeOpus4).decision).toBe('prompt');
  });
});
