/**
 * Policy types. SPEC §3.
 */

/** Persistence scope. */
export type PolicyScope = 'once' | 'session' | 'forever' | 'banned';

/** Effective decision. */
export type PolicyDecision = 'allow' | 'deny' | 'prompt';

/**
 * Conditional clause: a rule only matches when these model attributes
 * match the request. Strings are matched with the same shell-style globs
 * (`*`, `?`, `[seq]`) used for tool names — except `attribution_path`, which
 * uses flat-glob (where `*` also matches `/`).
 *
 * v0.6+. SPEC §3 open question (resolved).
 *
 * Multiple fields are conjunctive: the rule matches only when every
 * provided clause matches.
 */
export interface PolicyWhen {
  /** Match on `model.provider` (e.g., 'anthropic', 'openai', 'ollama'). */
  'model.provider'?: string;
  /** Match on `model.id` (e.g., 'claude-*-4.5*', 'gpt-5*', 'llama3*'). */
  'model.id'?: string;
  /**
   * Match on the rendered attribution path
   * `surface/aggregator/provider/id`. Flat-glob: `*` matches across `/`.
   * Examples: `'*\/RedPill/*\/*'`, `'FlowDot/*\/Anthropic/claude-*-4.*'`,
   * `'*claude-opus*'`. See `policy/attribution.ts`.
   */
  attribution_path?: string;
}

/** A single rule in the policy. */
export interface PolicyRule {
  /**
   * Tool pattern. Supports shell-style globs ( * ? [seq] ). May also be
   * `category:<name>` to target a category (SPEC §3.7).
   */
  tool: string;
  /** Persistence scope of this rule. */
  scope: PolicyScope;
  /**
   * Decision when the rule matches. Omit for `scope: banned` (implies `deny`).
   * For `scope: once|session|forever`, defaults to `allow`.
   */
  decision?: Exclude<PolicyDecision, 'prompt'>;
  /** Optional conditional clause. The rule only matches when all entries hold. */
  when?: PolicyWhen;
  /** Optional human note. Ignored by the evaluator. */
  notes?: string;
}

/** Loaded policy: defaults + rules. */
export interface Policy {
  /** Spec version of the policy file (e.g., '0.2'). */
  version: string;
  /** Agent id this policy applies to. */
  agent_id: string;
  /** Default behavior when no rule matches. */
  defaults: {
    scope: 'prompt' | PolicyScope;
    decision?: Exclude<PolicyDecision, 'prompt'>;
  };
  /** Rules in declaration order. */
  rules: PolicyRule[];
}

/** Result of evaluating a tool name against a policy. */
export interface PolicyEvaluation {
  decision: PolicyDecision;
  matchedRule: PolicyRule | undefined;
  matchedAt: 'exact' | 'wildcard' | 'category' | 'default';
  scope: PolicyScope | 'prompt';
}
