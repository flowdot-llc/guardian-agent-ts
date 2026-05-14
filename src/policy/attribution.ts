/**
 * Model-attribution path rendering + glob matching. SPEC §3 extension (v0.7+).
 *
 * A {@link ModelAttribution} renders to a 4-segment path:
 *
 *     surface / aggregator / provider / id
 *
 * Missing segments render as `'*'`. Examples:
 *
 *     { provider: 'Anthropic', id: 'claude-opus-4.5' }
 *       →  "* /* /Anthropic/claude-opus-4.5"
 *
 *     { surface: 'FlowDot', aggregator: 'RedPill',
 *       provider: 'Anthropic', id: 'claude-opus-4.5' }
 *       →  "FlowDot/RedPill/Anthropic/claude-opus-4.5"
 *
 * Pattern matching is **flat-glob**: `*` matches any run of characters
 * including `/`. This lets simple substring-style patterns like
 * `*claude-opus*` match the rendered path regardless of which provider,
 * aggregator, or surface issued the call. Authors who want to constrain a
 * specific segment write the slashes explicitly:
 *
 *     "* /RedPill/* /*"           → anything routed through RedPill
 *     "FlowDot/* /Anthropic/*"    → any Anthropic model from FlowDot, any aggregator
 *     "* /* /Anthropic/claude-*-4.5*"  → any claude-*-4.5* model from Anthropic
 *     "*claude-opus*"              → any claude-opus model anywhere
 *
 * Character classes (`[abc]`, `[!abc]`) and single-char wildcards (`?`) are
 * also supported — same semantics as `policy/evaluator.ts:globMatch` but
 * without the segment-bound restriction (since flat-glob has no segments).
 */

import type { ModelAttribution } from '../types.js';

/**
 * The placeholder used for missing segments. Chosen so a wildcard pattern
 * like `* /* /Anthropic/*` still matches an attribution missing both surface
 * and aggregator.
 */
export const ATTRIBUTION_MISSING_SEGMENT = '*';

/**
 * Render a {@link ModelAttribution} as a 4-segment path. Missing fields
 * become `'*'`. The path never contains an empty segment.
 */
export function renderAttributionPath(attribution: ModelAttribution): string {
  const surface = attribution.surface ?? ATTRIBUTION_MISSING_SEGMENT;
  const aggregator = attribution.aggregator ?? ATTRIBUTION_MISSING_SEGMENT;
  return `${surface}/${aggregator}/${attribution.provider}/${attribution.id}`;
}

/**
 * Test whether a pattern matches the rendered attribution path.
 *
 * Pattern syntax (flat-glob):
 *   `*`     — any run of characters, including `/`
 *   `?`     — exactly one character (including `/`)
 *   `[seq]` — character class
 *   `[!seq]` — negated character class
 *
 * The pattern is anchored: it matches the full path, not a prefix.
 */
export function matchAttributionPath(pattern: string, attribution: ModelAttribution): boolean {
  return flatGlobMatch(pattern, renderAttributionPath(attribution));
}

/**
 * Pattern matching against a raw rendered path string. Exposed for
 * `PolicyEvaluator` and for testing.
 */
export function flatGlobMatch(pattern: string, value: string): boolean {
  return flatGlobToRegExp(pattern).test(value);
}

function flatGlobToRegExp(pattern: string): RegExp {
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
  return body.replace(/[\\\]]/g, (m) => '\\' + m);
}
