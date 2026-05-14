import { describe, expect, it } from 'vitest';

import { PolicyEvaluator } from '../../src/policy/evaluator.js';
import type { Policy } from '../../src/policy/types.js';
import type { ModelAttribution } from '../../src/types.js';

function p(rules: Policy['rules']): Policy {
  return { version: '0.2', agent_id: 'a', defaults: { scope: 'prompt' }, rules };
}

const flowdotRedpillAnthropicOpus: ModelAttribution = {
  surface: 'FlowDot',
  aggregator: 'RedPill',
  provider: 'Anthropic',
  id: 'claude-opus-4.5',
};

const flowdotDirectAnthropicOpus: ModelAttribution = {
  surface: 'FlowDot',
  aggregator: 'direct',
  provider: 'Anthropic',
  id: 'claude-opus-4.5',
};

const legacyOpenAI: ModelAttribution = { provider: 'OpenAI', id: 'gpt-5' };

describe('PolicyEvaluator — attribution_path clause', () => {
  it('exact-path rule matches', () => {
    const ev = new PolicyEvaluator(
      p([
        {
          tool: 'send_email',
          scope: 'banned',
          when: {
            attribution_path: 'FlowDot/RedPill/Anthropic/claude-opus-4.5',
          },
        },
      ]),
    );
    expect(ev.evaluate('send_email', flowdotRedpillAnthropicOpus).decision).toBe('deny');
    expect(ev.evaluate('send_email', flowdotDirectAnthropicOpus).decision).toBe('prompt');
  });

  it('substring wildcard matches across segments', () => {
    const ev = new PolicyEvaluator(
      p([
        {
          tool: 'send_email',
          scope: 'forever',
          decision: 'allow',
          when: { attribution_path: '*claude-opus*' },
        },
      ]),
    );
    expect(ev.evaluate('send_email', flowdotRedpillAnthropicOpus).decision).toBe('allow');
    expect(ev.evaluate('send_email', flowdotDirectAnthropicOpus).decision).toBe('allow');
    expect(ev.evaluate('send_email', legacyOpenAI).decision).toBe('prompt');
  });

  it('aggregator-only constraint', () => {
    const ev = new PolicyEvaluator(
      p([
        {
          tool: 'place_order',
          scope: 'banned',
          when: { attribution_path: '*/RedPill/*/*' },
        },
      ]),
    );
    expect(ev.evaluate('place_order', flowdotRedpillAnthropicOpus).decision).toBe('deny');
    expect(ev.evaluate('place_order', flowdotDirectAnthropicOpus).decision).toBe('prompt');
  });

  it('combines with model.provider clause (both must match)', () => {
    const ev = new PolicyEvaluator(
      p([
        {
          tool: 'place_order',
          scope: 'banned',
          when: {
            'model.provider': 'Anthropic',
            attribution_path: '*/RedPill/*/*',
          },
        },
      ]),
    );
    expect(ev.evaluate('place_order', flowdotRedpillAnthropicOpus).decision).toBe('deny');
    // RedPill but wrong provider in `when` → no match → prompt
    expect(
      ev.evaluate('place_order', {
        surface: 'FlowDot',
        aggregator: 'RedPill',
        provider: 'OpenAI',
        id: 'gpt-5',
      }).decision,
    ).toBe('prompt');
  });

  it('rule with attribution_path fails to match when no model supplied', () => {
    const ev = new PolicyEvaluator(
      p([
        {
          tool: 'send_email',
          scope: 'banned',
          when: { attribution_path: '*/*/Anthropic/*' },
        },
      ]),
    );
    expect(ev.evaluate('send_email', undefined).decision).toBe('prompt');
  });

  it('legacy 2-field attribution renders with * for surface/aggregator and is matchable', () => {
    const ev = new PolicyEvaluator(
      p([
        {
          tool: 'send_email',
          scope: 'forever',
          decision: 'allow',
          when: { attribution_path: '*/*/OpenAI/gpt-*' },
        },
      ]),
    );
    expect(ev.evaluate('send_email', legacyOpenAI).decision).toBe('allow');
  });
});
