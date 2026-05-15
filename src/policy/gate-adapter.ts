/**
 * `policyStoreGate` — reference adapter wrapping a {@link PolicyStore} into the
 * {@link PolicyGate} shape expected by `GuardianRuntime`. v0.2.0+.
 *
 * Consumers are not required to use this adapter. It exists because the most
 * common pattern is "evaluator over the policy the store holds, with persist
 * forwarding to `store.addRule`", and writing that wrapper inline at every
 * surface bloats glue code.
 *
 * The adapter re-reads the policy on every `evaluate()` so that
 * operator-persisted rules from earlier in the same session are visible to
 * the next call without explicit cache invalidation. `PolicyStore` already
 * does in-memory parsing per call, so the overhead is bounded by
 * `readFileSync` of two small YAML files.
 */

import { PolicyEvaluator } from './evaluator.js';
import { PolicyStore } from './store.js';
import type { Policy, PolicyEvaluation, PolicyRule } from './types.js';
import type { ModelAttribution } from '../types.js';
import type { PolicyGate } from '../runtime/runtime.js';

export interface PolicyStoreGateOptions {
  /** Cache the underlying policy across evaluate() calls. Default: false
   *  (re-read on every evaluation so operator-persisted rules are picked up
   *  immediately). When true, the consumer is responsible for calling
   *  `invalidate()` after writes. */
  cache?: boolean;
}

/** Wrap a {@link PolicyStore} as a {@link PolicyGate}. */
export function policyStoreGate(
  store: PolicyStore,
  options: PolicyStoreGateOptions = {},
): PolicyGate & { invalidate: () => void } {
  const cache = options.cache === true;
  let cached: Policy | undefined;

  const getPolicy = (): Policy => {
    if (cache && cached !== undefined) return cached;
    const fresh = store.getPolicy();
    if (cache) cached = fresh;
    return fresh;
  };

  return {
    evaluate(toolName: string, model?: ModelAttribution): PolicyEvaluation {
      const evaluator = new PolicyEvaluator(getPolicy());
      return evaluator.evaluate(toolName, model);
    },
    async persist(rule: PolicyRule): Promise<void> {
      await store.addRule(rule);
      cached = undefined;
    },
    invalidate(): void {
      cached = undefined;
    },
  };
}
