/**
 * Behavioral baselines + descriptive statistics on audit-record streams.
 * SPEC §13 (v0.5.0+). Used by the offline `guardian-baseline` CLI; NEVER
 * consulted by the supervisor in the hot path (that would re-introduce
 * judgment).
 *
 * All functions are pure: same input → same output. The "is this
 * deviation significant?" question is mathematically grounded (mean + σ
 * thresholds) but operationally judgment-laden, so the library produces
 * descriptive reports and lets the operator decide what to do.
 */

import type { AuditRecord } from '../types.js';

// ============================================================================
// AgentProfile — the per-agent statistical summary
// ============================================================================

export interface AgentProfile {
  /** agent_id this profile describes. */
  agent_id: string;
  /** Schema version (bumped on incompatible profile-shape changes). */
  v: '1';
  /** Number of distinct session_id values observed. */
  session_count: number;
  /** Total records consumed (across kinds). */
  total_records: number;
  /** Total `tool_call` records observed. */
  tool_call_count: number;
  /** Mean events per session. */
  avg_session_length_events: number;
  /** Standard deviation of events-per-session. */
  stddev_session_length_events: number;
  /** Mean session wall-clock duration in ms. */
  avg_session_duration_ms: number;
  /** Standard deviation of session wall-clock duration in ms. */
  stddev_session_duration_ms: number;
  /** Per-tool call counts. Keys are tool names, values are integer counts. */
  tool_frequency: Record<string, number>;
  /** Counts per hour-of-day [0..23] from the record's `ts`. */
  hour_of_day: number[];
  /**
   * Counts per audit-record kind. Useful for spotting shifts like
   * "this agent suddenly emits a lot of denials."
   */
  kind_frequency: Record<string, number>;
  /** Counts per audit status. */
  status_frequency: Record<string, number>;
  /** ISO-8601 timestamp of the earliest record seen. */
  first_ts: string | null;
  /** ISO-8601 timestamp of the latest record seen. */
  last_ts: string | null;
  /** Stamp recording when the profile itself was produced. */
  generated_at: string;
}

/**
 * Build an {@link AgentProfile} for a single agent_id from a flat list of
 * audit records. Records belonging to other agent_ids are skipped silently
 * — callers can either pre-filter or use {@link analyzeMultiAgent} to get
 * profiles per agent.
 *
 * Deterministic given the same input.
 */
export function analyzeAgent(records: AuditRecord[], agentId: string): AgentProfile {
  const filtered = records.filter((r) => r.agent_id === agentId);
  return buildProfile(filtered, agentId);
}

/**
 * Bucket records by agent_id and build a profile for each. Returns a Map
 * keyed by agent_id (declaration order — Map insertion order matches first
 * occurrence in the input stream, for stable test output).
 */
export function analyzeMultiAgent(records: AuditRecord[]): Map<string, AgentProfile> {
  const groups = new Map<string, AuditRecord[]>();
  for (const r of records) {
    let g = groups.get(r.agent_id);
    if (!g) {
      g = [];
      groups.set(r.agent_id, g);
    }
    g.push(r);
  }
  const out = new Map<string, AgentProfile>();
  for (const [agentId, group] of groups) {
    out.set(agentId, buildProfile(group, agentId));
  }
  return out;
}

function buildProfile(records: AuditRecord[], agentId: string): AgentProfile {
  // Session bookkeeping
  const sessionEvents = new Map<string, AuditRecord[]>();
  for (const r of records) {
    const list = sessionEvents.get(r.session_id) ?? [];
    list.push(r);
    sessionEvents.set(r.session_id, list);
  }

  const eventsPerSession: number[] = [];
  const durationsMs: number[] = [];
  for (const list of sessionEvents.values()) {
    eventsPerSession.push(list.length);
    if (list.length < 2) {
      durationsMs.push(0);
      continue;
    }
    const sorted = [...list].sort((a, b) => a.ts.localeCompare(b.ts));
    const first = (sorted[0] as AuditRecord).ts;
    const last = (sorted[sorted.length - 1] as AuditRecord).ts;
    durationsMs.push(new Date(last).getTime() - new Date(first).getTime());
  }

  const toolFrequency: Record<string, number> = {};
  const kindFrequency: Record<string, number> = {};
  const statusFrequency: Record<string, number> = {};
  const hourOfDay: number[] = new Array<number>(24).fill(0);
  let toolCallCount = 0;
  let firstTs: string | null = null;
  let lastTs: string | null = null;

  for (const r of records) {
    kindFrequency[r.kind] = (kindFrequency[r.kind] ?? 0) + 1;
    statusFrequency[r.status] = (statusFrequency[r.status] ?? 0) + 1;
    if (r.kind === 'tool_call' && r.tool) {
      toolCallCount += 1;
      toolFrequency[r.tool.name] = (toolFrequency[r.tool.name] ?? 0) + 1;
    }
    const hour = new Date(r.ts).getUTCHours();
    if (!Number.isNaN(hour)) {
      hourOfDay[hour] = (hourOfDay[hour] as number) + 1;
    }
    if (firstTs === null || r.ts < firstTs) firstTs = r.ts;
    if (lastTs === null || r.ts > lastTs) lastTs = r.ts;
  }

  return {
    agent_id: agentId,
    v: '1',
    session_count: sessionEvents.size,
    total_records: records.length,
    tool_call_count: toolCallCount,
    avg_session_length_events: mean(eventsPerSession),
    stddev_session_length_events: stddev(eventsPerSession),
    avg_session_duration_ms: mean(durationsMs),
    stddev_session_duration_ms: stddev(durationsMs),
    tool_frequency: toolFrequency,
    hour_of_day: hourOfDay,
    kind_frequency: kindFrequency,
    status_frequency: statusFrequency,
    first_ts: firstTs,
    last_ts: lastTs,
    generated_at: new Date().toISOString(),
  };
}

// ============================================================================
// Deviation reporting (the `--check` path)
// ============================================================================

export interface Deviation {
  /** Which metric deviated. */
  metric: string;
  /** Observed value in the candidate session. */
  observed: number;
  /** Baseline mean (or count, depending on metric). */
  baseline: number;
  /** Number of σ from baseline. `null` when baseline has σ=0 (degenerate). */
  sigma: number | null;
  /** Free-form human label. */
  note: string;
}

export interface DeviationReport {
  agent_id: string;
  /** ISO-8601 of the candidate session's first record. */
  candidate_first_ts: string | null;
  /** ISO-8601 of the candidate session's last record. */
  candidate_last_ts: string | null;
  /** All deviations exceeding the configured threshold, in observed order. */
  deviations: Deviation[];
}

export interface CompareOptions {
  /** σ threshold for flagging. Default 3. */
  sigmaThreshold?: number;
  /** Minimum sessions required in baseline before σ checks are meaningful. */
  minBaselineSessions?: number;
}

/**
 * Compare a candidate profile against a saved baseline. Returns the set of
 * deviations that exceeded `sigmaThreshold` σ. When σ is undefined (the
 * baseline only has one session, so σ=0), the metric is reported with
 * `sigma: null` and is included only if the observed value differs from
 * baseline at all.
 *
 * Deviation list is ordered by metric name for stable output.
 */
export function compareToBaseline(
  candidate: AgentProfile,
  baseline: AgentProfile,
  options: CompareOptions = {},
): DeviationReport {
  const threshold = options.sigmaThreshold ?? 3;
  const minSessions = options.minBaselineSessions ?? 2;
  const deviations: Deviation[] = [];

  if (baseline.session_count >= minSessions) {
    pushIfDeviated(deviations, 'avg_session_length_events', candidate.avg_session_length_events, baseline.avg_session_length_events, baseline.stddev_session_length_events, threshold);
    pushIfDeviated(deviations, 'avg_session_duration_ms', candidate.avg_session_duration_ms, baseline.avg_session_duration_ms, baseline.stddev_session_duration_ms, threshold);
  }

  // Tool-frequency: flag any tool that appears in candidate >0 times but
  // 0 times in baseline (and vice versa, though that's less interesting).
  const baselineTools = new Set(Object.keys(baseline.tool_frequency));
  for (const [tool, count] of Object.entries(candidate.tool_frequency)) {
    if (!baselineTools.has(tool)) {
      deviations.push({
        metric: `tool_frequency.${tool}`,
        observed: count,
        baseline: 0,
        sigma: null,
        note: 'tool not present in baseline',
      });
    }
  }

  // Stable order.
  deviations.sort((a, b) => a.metric.localeCompare(b.metric));

  return {
    agent_id: candidate.agent_id,
    candidate_first_ts: candidate.first_ts,
    candidate_last_ts: candidate.last_ts,
    deviations,
  };
}

function pushIfDeviated(
  out: Deviation[],
  metric: string,
  observed: number,
  baselineMean: number,
  baselineStddev: number,
  threshold: number,
): void {
  if (baselineStddev === 0) {
    if (observed !== baselineMean) {
      out.push({
        metric,
        observed,
        baseline: baselineMean,
        sigma: null,
        note: 'baseline σ=0; any difference is flagged',
      });
    }
    return;
  }
  const sigma = Math.abs(observed - baselineMean) / baselineStddev;
  if (sigma >= threshold) {
    out.push({
      metric,
      observed,
      baseline: baselineMean,
      sigma,
      note: `${sigma.toFixed(2)}σ from baseline mean ${baselineMean.toFixed(2)}`,
    });
  }
}

// ============================================================================
// Small stats helpers
// ============================================================================

/** Arithmetic mean. Returns 0 for empty input. */
export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Population standard deviation. Returns 0 for inputs of length < 2. */
export function stddev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  let sumSq = 0;
  for (const v of values) {
    const d = v - m;
    sumSq += d * d;
  }
  return Math.sqrt(sumSq / values.length);
}
