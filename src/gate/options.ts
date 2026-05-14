/**
 * Gate option sets. SPEC §4 (extension).
 *
 * The fixed 5-button `GateDecision` enum (`allow`/`allow_session`/
 * `allow_forever`/`deny`/`ban_forever`) is preserved for back-compat. This
 * module adds a parallel configurable-option-set system: consumers declare
 * which buttons to show, with their own ids/labels, and the library carries
 * the chosen-option id through gate responses + audit records.
 *
 * FlowDot uses {@link FLOWDOT_FIVE} on its voice/live surface and
 * {@link CLASSIC_FOUR} on its file-permission surface. Anyone else can ship
 * their own `GateOptionSet`.
 */

import type { PolicyScope } from '../policy/types.js';
import type { GateGranularity } from './types.js';

/**
 * One button in an approval prompt.
 *
 * - `id` is the stable wire string surfaced in `GateResponse.chosen_option_id`
 *   and recorded in audit records. Keep it short and ASCII (`once`,
 *   `session`, `toolkit`, etc.).
 * - `scope` is what gets persisted if the consumer's policy store records the
 *   answer. `'once'` means do-not-persist.
 * - `decision` is the immediate yes/no for THIS call.
 * - `granularity` controls what the persisted rule covers when `scope` is
 *   anything other than `'once'`. `'tool'` is the default and means "this
 *   specific tool name"; `'toolkit'` means "every tool in this toolkit";
 *   `'category'` means "every tool in this category".
 */
export interface GateOption {
  id: string;
  label?: string;
  scope: PolicyScope;
  decision: 'allow' | 'deny';
  granularity?: GateGranularity;
}

/**
 * A named collection of {@link GateOption}s, ordered for display.
 *
 * Consumers SHOULD render options in declaration order. The library does not
 * enforce uniqueness of `id` within a set — but lookups by id return the
 * first match, so duplicates only confuse readers.
 */
export interface GateOptionSet {
  /** Stable identifier for the set itself (recorded in audit on gate_request). */
  id: string;
  /** Optional human note describing what this set is for. */
  description?: string;
  /** The options, in display order. */
  options: GateOption[];
}

/**
 * FlowDot's live-call gate. Five buttons.
 *
 * - `once` — allow this call only, persist nothing
 * - `session` — allow for this session
 * - `tool` — allow this specific tool forever
 * - `toolkit` — allow every tool in this toolkit forever
 * - `deny` — refuse this call
 */
export const FLOWDOT_FIVE: GateOptionSet = {
  id: 'flowdot-five',
  description: 'FlowDot voice/live tool-call approval (5 buttons).',
  options: [
    { id: 'once', label: 'Allow once', scope: 'once', decision: 'allow', granularity: 'tool' },
    {
      id: 'session',
      label: 'Allow for this session',
      scope: 'session',
      decision: 'allow',
      granularity: 'tool',
    },
    {
      id: 'tool',
      label: 'Always allow this tool',
      scope: 'forever',
      decision: 'allow',
      granularity: 'tool',
    },
    {
      id: 'toolkit',
      label: 'Always allow this toolkit',
      scope: 'forever',
      decision: 'allow',
      granularity: 'toolkit',
    },
    { id: 'deny', label: 'Deny', scope: 'once', decision: 'deny', granularity: 'tool' },
  ],
};

/**
 * FlowDot's classic file-permission gate. Four scopes (`banned` is implied by
 * a deny-forever option).
 *
 * - `once` — allow this call only
 * - `session` — allow for this session
 * - `forever` — allow this tool forever
 * - `banned` — deny this tool forever
 */
export const CLASSIC_FOUR: GateOptionSet = {
  id: 'classic-four',
  description: 'FlowDot file-permission scopes (once/session/forever/banned).',
  options: [
    { id: 'once', label: 'Allow once', scope: 'once', decision: 'allow', granularity: 'tool' },
    {
      id: 'session',
      label: 'Allow for this session',
      scope: 'session',
      decision: 'allow',
      granularity: 'tool',
    },
    {
      id: 'forever',
      label: 'Always allow',
      scope: 'forever',
      decision: 'allow',
      granularity: 'tool',
    },
    {
      id: 'banned',
      label: 'Never allow',
      scope: 'banned',
      decision: 'deny',
      granularity: 'tool',
    },
  ],
};

/**
 * Build a custom option set. Useful for consumers who want a non-standard
 * combination — e.g. a "stop the world" pseudo-option that triggers an estop.
 *
 * Throws if `options` is empty or contains duplicate ids.
 */
export function defineGateOptionSet(id: string, options: GateOption[], description?: string): GateOptionSet {
  if (options.length === 0) {
    throw new Error('defineGateOptionSet: options must be non-empty');
  }
  const seen = new Set<string>();
  for (const o of options) {
    if (seen.has(o.id)) {
      throw new Error(`defineGateOptionSet: duplicate option id ${JSON.stringify(o.id)}`);
    }
    seen.add(o.id);
  }
  const out: GateOptionSet = { id, options };
  if (description !== undefined) out.description = description;
  return out;
}

/**
 * Find an option by id. Returns `undefined` when no match.
 */
export function findOption(set: GateOptionSet, optionId: string): GateOption | undefined {
  return set.options.find((o) => o.id === optionId);
}

/**
 * Resolve a chosen option id against a set. Returns the option, or throws
 * with a clear message listing the valid ids. Use this when an external
 * caller (UI, IPC frame, data-channel response) provides a string and you
 * want to fail loudly on typos.
 */
export function resolveOption(set: GateOptionSet, optionId: string): GateOption {
  const found = findOption(set, optionId);
  if (!found) {
    const valid = set.options.map((o) => o.id).join(', ');
    throw new Error(
      `Unknown gate option ${JSON.stringify(optionId)} for set ${JSON.stringify(set.id)}. Valid: ${valid}.`,
    );
  }
  return found;
}
