/**
 * Honeytoken detection. SPEC §11 (v0.3.0+).
 *
 * The library exposes two zero-false-positive-by-construction defenses:
 *
 * 1. **Value match.** Consumer registers a set of decoy strings or regexes
 *    that should NEVER legitimately appear in a tool call's arguments
 *    (e.g., a fake `AKIA...` key stashed in a never-read env var, a
 *    phantom file path `~/.flowdot/keys/recovery.pem` that exists but
 *    contains only a marker). The matcher walks the canonical-JSON
 *    representation of every tool call's args; any hit means an agent has
 *    been probing.
 *
 * 2. **Phantom tool.** Consumer registers a tool name that is documented
 *    internally as "do not call" — never advertised to legitimate agents.
 *    Any dispatch to that tool name → immediate fire.
 *
 * Both modes are deterministic predicates over input. Zero false positives
 * by construction: if a legitimate workflow ever references a honeytoken,
 * the operator either misconfigured the set or the workflow actually does
 * touch sensitive data and the supervisor's catch is correct.
 *
 * The library SHIPS NO DEFAULT TOKENS. Anti-pattern: a library shipping
 * fake-looking AWS keys gets picked up by secret scanners + creates support
 * load. Consumers register their own tokens via `HoneytokenSet`.
 */

import { canonicalJsonStringify } from '../audit/chain.js';

/**
 * A single decoy. Exactly one of `value` or `pattern` must be set.
 *
 * - `value` matches substring (case-sensitive). Use for fixed marker strings.
 * - `pattern` matches against the canonical-JSON of args via regex. Use for
 *   shape-based tokens (`/AKIA[0-9A-Z]{16}/`, etc.).
 */
export interface Honeytoken {
  /** Stable id. Recorded in audit + estop reason. ASCII, short. */
  id: string;
  /** Free-form description for ops review. Ignored by the matcher. */
  description?: string;
  /** Literal substring to match. Mutually exclusive with `pattern`. */
  value?: string;
  /** Regex to test against canonical-JSON of args. Mutually exclusive with `value`. */
  pattern?: RegExp;
}

/**
 * A collection of honeytokens for one supervisor instance. Order does not
 * affect detection; the matcher returns the first hit.
 *
 * Ids must be unique within the set.
 */
export interface HoneytokenSet {
  /** Stable identifier for the set itself. */
  id: string;
  /** Optional description. */
  description?: string;
  /** Value/pattern tokens scanned against `tool.args`. */
  tokens: Honeytoken[];
  /**
   * Phantom tool names. Any dispatch to one of these names triggers
   * immediately, regardless of args.
   */
  phantomTools?: string[];
}

/**
 * Result of a single match attempt.
 */
export type HoneytokenHit =
  | { kind: 'value_in_args'; tokenId: string }
  | { kind: 'phantom_tool'; toolName: string };

/**
 * Build a honeytoken set with id-uniqueness + xor-validation enforced.
 *
 * Throws on:
 *   - empty `tokens` AND empty `phantomTools` (the set would never fire)
 *   - duplicate token ids
 *   - duplicate phantom tool names
 *   - a token with neither `value` nor `pattern`
 *   - a token with BOTH `value` and `pattern`
 */
export function defineHoneytokenSet(
  id: string,
  tokens: Honeytoken[],
  phantomTools: string[] = [],
  description?: string,
): HoneytokenSet {
  if (tokens.length === 0 && phantomTools.length === 0) {
    throw new Error('defineHoneytokenSet: provide at least one token or phantom tool');
  }
  const tokenIds = new Set<string>();
  for (const t of tokens) {
    if (tokenIds.has(t.id)) {
      throw new Error(`defineHoneytokenSet: duplicate token id ${JSON.stringify(t.id)}`);
    }
    tokenIds.add(t.id);
    const hasValue = t.value !== undefined;
    const hasPattern = t.pattern !== undefined;
    if (!hasValue && !hasPattern) {
      throw new Error(
        `defineHoneytokenSet: token ${JSON.stringify(t.id)} must set either value or pattern`,
      );
    }
    if (hasValue && hasPattern) {
      throw new Error(
        `defineHoneytokenSet: token ${JSON.stringify(t.id)} sets both value and pattern; choose one`,
      );
    }
  }
  const phantomSet = new Set<string>();
  for (const name of phantomTools) {
    if (phantomSet.has(name)) {
      throw new Error(`defineHoneytokenSet: duplicate phantom tool ${JSON.stringify(name)}`);
    }
    phantomSet.add(name);
  }
  const out: HoneytokenSet = { id, tokens, phantomTools };
  if (description !== undefined) out.description = description;
  return out;
}

/**
 * Test whether a tool name is a phantom tool in the set. Returns the hit
 * descriptor on match, `null` otherwise.
 */
export function matchPhantomTool(set: HoneytokenSet, toolName: string): HoneytokenHit | null {
  if (!set.phantomTools) return null;
  if (set.phantomTools.includes(toolName)) {
    return { kind: 'phantom_tool', toolName };
  }
  return null;
}

/**
 * Test whether any honeytoken value or pattern appears in the canonical-JSON
 * representation of `args`. Returns the FIRST hit. Order of `tokens` in the
 * set determines which hit wins when multiple match.
 *
 * `args` is canonicalized to JSON before scanning so the matcher catches
 * tokens regardless of nesting depth, key/value placement, or array index.
 */
export function matchHoneytokenInArgs(
  set: HoneytokenSet,
  args: unknown,
): HoneytokenHit | null {
  if (set.tokens.length === 0) return null;
  const json = canonicalJsonStringify(args);
  for (const t of set.tokens) {
    if (t.value !== undefined) {
      if (json.includes(t.value)) {
        return { kind: 'value_in_args', tokenId: t.id };
      }
    } else if (t.pattern !== undefined) {
      if (t.pattern.test(json)) {
        return { kind: 'value_in_args', tokenId: t.id };
      }
    }
  }
  return null;
}

/**
 * Compose phantom-tool + value-in-args checks. Phantom-tool match wins over
 * value-in-args when both would fire (phantom-tool is the stronger signal:
 * a literal call to a forbidden name).
 */
export function checkHoneytoken(
  set: HoneytokenSet,
  toolName: string,
  args: unknown,
): HoneytokenHit | null {
  return matchPhantomTool(set, toolName) ?? matchHoneytokenInArgs(set, args);
}
