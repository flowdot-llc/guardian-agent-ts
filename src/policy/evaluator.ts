/**
 * PolicyEvaluator — resolution order + wildcards. SPEC §3.3, §3.4.
 *
 * Resolution order:
 *   1. banned (forever-deny) exact match
 *   2. banned wildcard match
 *   3. forever-allow exact match
 *   4. forever-allow wildcard match
 *   5. session-allow exact match
 *   6. session-allow wildcard match
 *   7. once-allow exact match (rare — `once` is normally not persisted but
 *      can appear if a runtime queries with a transient rule loaded)
 *   8. once-allow wildcard match
 *   9. defaults.scope if not 'prompt'
 *  10. 'prompt' (consult gate)
 *
 * Banned-beats-allow at every layer: a `scope: banned` rule cannot be
 * overridden by an allow rule at any other scope.
 */

import type { ModelAttribution } from '../types.js';
import type { Policy, PolicyEvaluation, PolicyRule, PolicyScope } from './types.js';

const RANK: Record<PolicyScope, number> = {
  banned: 0,
  forever: 1,
  session: 2,
  once: 3,
};

export class PolicyEvaluator {
  private readonly policy: Policy;

  constructor(policy: Policy) {
    this.policy = policy;
  }

  /** Evaluate a tool name (optionally with model attribution for `when` rules). */
  evaluate(toolName: string, model?: ModelAttribution): PolicyEvaluation {
    // Walk rules in resolution order. We sort once on construction to make
    // multiple evaluations cheap, but for code simplicity we do it per-call.
    const banned = this.firstMatch(
      toolName,
      (r) => r.scope === 'banned' && whenMatches(r, model),
    );
    if (banned !== null) {
      return {
        decision: 'deny',
        matchedRule: banned.rule,
        matchedAt: banned.matchedAt,
        scope: 'banned',
      };
    }

    // Walk allow scopes in order forever > session > once.
    for (const scope of ['forever', 'session', 'once'] as const) {
      const m = this.firstMatch(
        toolName,
        (r) =>
          r.scope === scope && effectiveDecision(r) === 'allow' && whenMatches(r, model),
      );
      if (m !== null) {
        return {
          decision: 'allow',
          matchedRule: m.rule,
          matchedAt: m.matchedAt,
          scope,
        };
      }
      // A deny at this scope also short-circuits (though uncommon outside `banned`).
      const denyAt = this.firstMatch(
        toolName,
        (r) =>
          r.scope === scope && effectiveDecision(r) === 'deny' && whenMatches(r, model),
      );
      if (denyAt !== null) {
        return {
          decision: 'deny',
          matchedRule: denyAt.rule,
          matchedAt: denyAt.matchedAt,
          scope,
        };
      }
    }

    // Fall back to defaults.
    const d = this.policy.defaults;
    if (d.scope === 'prompt') {
      return {
        decision: 'prompt',
        matchedRule: undefined,
        matchedAt: 'default',
        scope: 'prompt',
      };
    }
    const decision = d.decision ?? (d.scope === 'banned' ? 'deny' : 'allow');
    return {
      decision,
      matchedRule: undefined,
      matchedAt: 'default',
      scope: d.scope as PolicyScope,
    };
  }

  /** Helper for tests / debugging. */
  rankFor(scope: PolicyScope): number {
    return RANK[scope];
  }

  // ---- internal --------------------------------------------------------------

  private firstMatch(
    toolName: string,
    pred: (rule: PolicyRule) => boolean,
  ): { rule: PolicyRule; matchedAt: 'exact' | 'wildcard' | 'category' } | null {
    // Exact match: rule.tool equals toolName (and `pred` holds). Category
    // matches (`category:<name>` form) also flow through here — the prefix is
    // just a naming convention. `matchedAt: 'category'` is reserved for a
    // future wildcard-category form not yet specified.
    for (const rule of this.policy.rules) {
      if (rule.tool === toolName && pred(rule)) {
        return { rule, matchedAt: 'exact' };
      }
    }
    // Wildcard match (declaration order wins among multiple matches).
    for (const rule of this.policy.rules) {
      if (rule.tool === toolName) continue; // already handled
      if (containsGlobChars(rule.tool) && globMatch(rule.tool, toolName) && pred(rule)) {
        return { rule, matchedAt: 'wildcard' };
      }
    }
    return null;
  }
}

function effectiveDecision(rule: PolicyRule): 'allow' | 'deny' {
  /* c8 ignore start */
  if (rule.scope === 'banned') return 'deny';
  /* c8 ignore stop */
  return rule.decision ?? 'allow';
}

/**
 * Returns true iff the rule's `when` clause is satisfied by the given model.
 * Rules without `when` always match. Glob support: `*`, `?`, `[seq]`.
 *
 * If `when` requires a model attribute but no model is supplied, the rule
 * fails to match (defensive — model-conditional rules SHOULD NOT fire
 * unconditionally).
 */
function whenMatches(rule: PolicyRule, model: ModelAttribution | undefined): boolean {
  if (!rule.when) return true;
  if (rule.when['model.provider'] !== undefined) {
    if (!model) return false;
    if (!globMatch(rule.when['model.provider'], model.provider)) return false;
  }
  if (rule.when['model.id'] !== undefined) {
    if (!model) return false;
    if (!globMatch(rule.when['model.id'], model.id)) return false;
  }
  return true;
}

function containsGlobChars(s: string): boolean {
  return s.includes('*') || s.includes('?') || s.includes('[');
}

/**
 * Minimal fnmatch-equivalent. Supports `*` (any sequence), `?` (one char),
 * and `[seq]` / `[!seq]` character classes.
 */
export function globMatch(pattern: string, name: string): boolean {
  const re = globToRegExp(pattern);
  return re.test(name);
}

function globToRegExp(pattern: string): RegExp {
  let out = '^';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i] as string;
    if (c === '*') {
      out += '.*';
      i++;
    } else if (c === '?') {
      out += '.';
      i++;
    } else if (c === '[') {
      // Character class
      let end = i + 1;
      let negate = false;
      if (pattern[end] === '!') {
        negate = true;
        end++;
      }
      let body = '';
      while (end < pattern.length && pattern[end] !== ']') {
        body += pattern[end];
        end++;
      }
      if (end >= pattern.length) {
        // unmatched '[' — treat literally.
        out += '\\[';
        i++;
      } else {
        out += '[' + (negate ? '^' : '') + escapeForCharClass(body) + ']';
        i = end + 1;
      }
    } else {
      out += escapeRegex(c);
      i++;
    }
  }
  out += '$';
  return new RegExp(out);
}

function escapeRegex(c: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(c) ? '\\' + c : c;
}

function escapeForCharClass(body: string): string {
  // Inside a char class, escape `]` and `\` only.
  return body.replace(/[\\\]]/g, (m) => '\\' + m);
}
