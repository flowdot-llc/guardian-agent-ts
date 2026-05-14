/**
 * Cross-surface correlation. SPEC §14 (v0.5.0+).
 *
 * Reads audit records from multiple sources (typically one per surface —
 * `cli.jsonl`, `mcp.jsonl`, etc.) and looks for patterns that span
 * surfaces under the same `agent_id`:
 *
 *   - Overlapping sessions: same agent_id running concurrent sessions on
 *     two different surfaces.
 *   - Identical args: canonical-JSON-SHA256 of `tool.args` collides
 *     across surfaces within a configurable time window.
 *   - Sequence similarity: cosine similarity of per-session tool-frequency
 *     vectors above a configurable threshold.
 *
 * All three patterns are deterministic predicates on input. The library
 * produces match records; the operator decides what to do with them.
 *
 * Read-only on source audit files. Output is written to a separate
 * `correlations.jsonl` log so source-log integrity (hash chain,
 * signatures) is never touched.
 */

import { createHash } from 'node:crypto';

import type { AuditRecord } from '../types.js';
import { canonicalJsonStringify } from './chain.js';

// ============================================================================
// Source = one audit file = one surface
// ============================================================================

export interface AuditSource {
  /** Stable surface id, used in match records. Typical: `'cli'`, `'mcp'`, `'native'`. */
  surface: string;
  /** Records from this surface. Caller is responsible for loading. */
  records: AuditRecord[];
}

// ============================================================================
// SessionSummary — per-session shape used by the matchers
// ============================================================================

export interface SessionSummary {
  surface: string;
  agent_id: string;
  session_id: string;
  /** Earliest record `ts` (ISO-8601). */
  start: string;
  /** Latest record `ts` (ISO-8601). */
  end: string;
  /** Wall-clock duration in ms. */
  duration_ms: number;
  /** Per-tool call counts. */
  tool_frequency: Record<string, number>;
  /** SHA-256(canonical-JSON(args)) for each tool_call record in this session, in order. */
  args_hashes: { event_id: string; ts: string; tool_name: string; args_hash: string }[];
}

/**
 * Summarize a source's records into one entry per (agent_id, session_id).
 */
export function summarizeSessions(source: AuditSource): SessionSummary[] {
  const map = new Map<string, SessionSummary>();
  for (const r of source.records) {
    const key = `${r.agent_id}::${r.session_id}`;
    let s = map.get(key);
    if (!s) {
      s = {
        surface: source.surface,
        agent_id: r.agent_id,
        session_id: r.session_id,
        start: r.ts,
        end: r.ts,
        duration_ms: 0,
        tool_frequency: {},
        args_hashes: [],
      };
      map.set(key, s);
    }
    if (r.ts < s.start) s.start = r.ts;
    if (r.ts > s.end) s.end = r.ts;
    if (r.kind === 'tool_call' && r.tool) {
      s.tool_frequency[r.tool.name] = (s.tool_frequency[r.tool.name] ?? 0) + 1;
      s.args_hashes.push({
        event_id: r.event_id,
        ts: r.ts,
        tool_name: r.tool.name,
        args_hash: hashArgs(r.tool.args),
      });
    }
  }
  // Compute duration once.
  for (const s of map.values()) {
    s.duration_ms = new Date(s.end).getTime() - new Date(s.start).getTime();
  }
  return Array.from(map.values());
}

function hashArgs(args: unknown): string {
  return 'sha256:' + createHash('sha256').update(canonicalJsonStringify(args)).digest('hex');
}

// ============================================================================
// Matches
// ============================================================================

/**
 * One correlation finding. Written as a JSONL row with `kind:
 * 'x_cross_surface_match'` to the operator's correlations log.
 */
export interface CorrelationMatch {
  kind: 'x_cross_surface_match';
  agent_id: string;
  match_type: 'overlapping_sessions' | 'args_hash_collision' | 'sequence_similarity';
  /** Always 2 surfaces (pairwise). */
  surfaces: [string, string];
  /** Session ids on each side, in surfaces order. */
  session_ids: [string, string];
  detail: Record<string, unknown>;
}

export interface CorrelationOptions {
  /**
   * For args-hash collisions: max ms between the two collisions to count as
   * a match. Default 60_000 (1 min) — collisions further apart aren't
   * load-bearing for "running in parallel."
   */
  argsHashWindowMs?: number;
  /**
   * For sequence similarity: cosine threshold in [0,1]. Default 0.9 —
   * very similar tool-frequency vectors across surfaces in close time.
   */
  similarityThreshold?: number;
  /**
   * For sequence similarity: only compare sessions whose time windows are
   * within this many ms of each other (start-to-start). Default 600_000
   * (10 min).
   */
  similarityWindowMs?: number;
  /**
   * For sequence similarity: minimum tool_call count per session to be
   * considered. Vectors that are too sparse trivially correlate.
   * Default 5.
   */
  similarityMinCalls?: number;
}

const DEFAULT_OPTS: Required<CorrelationOptions> = {
  argsHashWindowMs: 60_000,
  similarityThreshold: 0.9,
  similarityWindowMs: 600_000,
  similarityMinCalls: 5,
};

/**
 * Run all three correlators across the given sources. Returns matches in
 * insertion order (overlap → hash → similarity).
 */
export function correlate(
  sources: readonly AuditSource[],
  options: CorrelationOptions = {},
): CorrelationMatch[] {
  const opts: Required<CorrelationOptions> = { ...DEFAULT_OPTS, ...options };
  const summaries = sources.flatMap((s) => summarizeSessions(s));
  // Index by agent_id.
  const byAgent = new Map<string, SessionSummary[]>();
  for (const s of summaries) {
    let list = byAgent.get(s.agent_id);
    if (!list) {
      list = [];
      byAgent.set(s.agent_id, list);
    }
    list.push(s);
  }
  const out: CorrelationMatch[] = [];
  for (const sessions of byAgent.values()) {
    out.push(...findOverlappingSessions(sessions));
    out.push(...findArgsHashCollisions(sessions, opts.argsHashWindowMs));
    out.push(...findSequenceSimilarity(sessions, opts));
  }
  return out;
}

/**
 * Detect pairs of sessions on different surfaces (same agent_id) whose
 * time windows overlap. "Overlap" = [start1,end1] ∩ [start2,end2] ≠ ∅.
 */
export function findOverlappingSessions(sessions: SessionSummary[]): CorrelationMatch[] {
  const out: CorrelationMatch[] = [];
  for (let i = 0; i < sessions.length; i++) {
    for (let j = i + 1; j < sessions.length; j++) {
      const a = sessions[i] as SessionSummary;
      const b = sessions[j] as SessionSummary;
      if (a.surface === b.surface) continue;
      const aStart = new Date(a.start).getTime();
      const aEnd = new Date(a.end).getTime();
      const bStart = new Date(b.start).getTime();
      const bEnd = new Date(b.end).getTime();
      if (aStart <= bEnd && bStart <= aEnd) {
        const overlapStart = Math.max(aStart, bStart);
        const overlapEnd = Math.min(aEnd, bEnd);
        out.push({
          kind: 'x_cross_surface_match',
          agent_id: a.agent_id,
          match_type: 'overlapping_sessions',
          surfaces: [a.surface, b.surface],
          session_ids: [a.session_id, b.session_id],
          detail: {
            overlap_start: new Date(overlapStart).toISOString(),
            overlap_end: new Date(overlapEnd).toISOString(),
            overlap_ms: overlapEnd - overlapStart,
            session_a_window: [a.start, a.end],
            session_b_window: [b.start, b.end],
          },
        });
      }
    }
  }
  return out;
}

/**
 * Detect args-hash collisions across surfaces within a time window for the
 * same agent_id. A collision means: identical canonical-JSON-SHA256(args)
 * for the same `tool_name`, in two different surfaces, within `windowMs`.
 */
export function findArgsHashCollisions(
  sessions: SessionSummary[],
  windowMs: number,
): CorrelationMatch[] {
  const out: CorrelationMatch[] = [];
  // Flatten + index by (tool_name, args_hash).
  type Entry = SessionSummary['args_hashes'][number] & { session: SessionSummary };
  const byKey = new Map<string, Entry[]>();
  for (const session of sessions) {
    for (const h of session.args_hashes) {
      const key = `${h.tool_name}::${h.args_hash}`;
      let list = byKey.get(key);
      if (!list) {
        list = [];
        byKey.set(key, list);
      }
      list.push({ ...h, session });
    }
  }
  for (const [key, entries] of byKey) {
    if (entries.length < 2) continue;
    // Pairwise: find pairs in different surfaces within windowMs.
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i] as Entry;
        const b = entries[j] as Entry;
        if (a.session.surface === b.session.surface) continue;
        const aT = new Date(a.ts).getTime();
        const bT = new Date(b.ts).getTime();
        if (Math.abs(aT - bT) > windowMs) continue;
        const [tool_name, args_hash] = key.split('::') as [string, string];
        out.push({
          kind: 'x_cross_surface_match',
          agent_id: a.session.agent_id,
          match_type: 'args_hash_collision',
          surfaces: [a.session.surface, b.session.surface],
          session_ids: [a.session.session_id, b.session.session_id],
          detail: {
            tool_name,
            args_hash,
            event_id_a: a.event_id,
            event_id_b: b.event_id,
            delta_ms: Math.abs(aT - bT),
          },
        });
      }
    }
  }
  return out;
}

/**
 * Detect pairs of sessions on different surfaces (same agent_id) whose
 * tool-frequency vectors have cosine similarity above the threshold AND
 * whose start times are within `similarityWindowMs`.
 */
export function findSequenceSimilarity(
  sessions: SessionSummary[],
  options: Required<CorrelationOptions>,
): CorrelationMatch[] {
  const out: CorrelationMatch[] = [];
  // Build vocabulary.
  const vocab = new Set<string>();
  for (const s of sessions) {
    for (const name of Object.keys(s.tool_frequency)) vocab.add(name);
  }
  const vocabList = Array.from(vocab);
  for (let i = 0; i < sessions.length; i++) {
    for (let j = i + 1; j < sessions.length; j++) {
      const a = sessions[i] as SessionSummary;
      const b = sessions[j] as SessionSummary;
      if (a.surface === b.surface) continue;
      const aCalls = sumValues(a.tool_frequency);
      const bCalls = sumValues(b.tool_frequency);
      if (aCalls < options.similarityMinCalls || bCalls < options.similarityMinCalls) continue;
      const dt = Math.abs(new Date(a.start).getTime() - new Date(b.start).getTime());
      if (dt > options.similarityWindowMs) continue;
      const sim = cosineSimilarity(a.tool_frequency, b.tool_frequency, vocabList);
      if (sim >= options.similarityThreshold) {
        out.push({
          kind: 'x_cross_surface_match',
          agent_id: a.agent_id,
          match_type: 'sequence_similarity',
          surfaces: [a.surface, b.surface],
          session_ids: [a.session_id, b.session_id],
          detail: {
            cosine_similarity: sim,
            window_dt_ms: dt,
            session_a_calls: aCalls,
            session_b_calls: bCalls,
          },
        });
      }
    }
  }
  return out;
}

function sumValues(m: Record<string, number>): number {
  let s = 0;
  for (const v of Object.values(m)) s += v;
  return s;
}

function cosineSimilarity(
  a: Record<string, number>,
  b: Record<string, number>,
  vocab: readonly string[],
): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (const term of vocab) {
    const va = a[term] ?? 0;
    const vb = b[term] ?? 0;
    dot += va * vb;
    magA += va * va;
    magB += vb * vb;
  }
  /* c8 ignore next */
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}
