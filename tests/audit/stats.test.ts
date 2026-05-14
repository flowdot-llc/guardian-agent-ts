import { describe, expect, it } from 'vitest';

import {
  analyzeAgent,
  analyzeMultiAgent,
  compareToBaseline,
  mean,
  stddev,
} from '../../src/audit/stats.js';
import type { AuditRecord } from '../../src/types.js';

function rec(
  partial: Partial<AuditRecord> & { agent_id: string; session_id: string; ts: string; kind: AuditRecord['kind']; status: AuditRecord['status'] },
): AuditRecord {
  return {
    v: '0.2.0',
    event_id: 'evt_x',
    initiator: 'agent',
    prev_hash: 'sha256:0',
    ...partial,
  };
}

describe('mean / stddev', () => {
  it('mean of empty array is 0', () => {
    expect(mean([])).toBe(0);
  });
  it('mean of [1,2,3] is 2', () => {
    expect(mean([1, 2, 3])).toBe(2);
  });
  it('stddev of empty / single-element is 0', () => {
    expect(stddev([])).toBe(0);
    expect(stddev([5])).toBe(0);
  });
  it('stddev of [1,2,3,4,5] is sqrt(2)', () => {
    expect(stddev([1, 2, 3, 4, 5])).toBeCloseTo(Math.sqrt(2), 10);
  });
});

describe('analyzeAgent', () => {
  it('returns an empty profile for an agent with no records', () => {
    const records = [
      rec({ agent_id: 'a', session_id: 's', ts: '2026-01-01T00:00:00.000Z', kind: 'tool_call', status: 'pending' }),
    ];
    const p = analyzeAgent(records, 'other-agent');
    expect(p.total_records).toBe(0);
    expect(p.session_count).toBe(0);
  });

  it('counts tool calls + session count + total records correctly', () => {
    const records: AuditRecord[] = [
      rec({ agent_id: 'a', session_id: 's1', ts: '2026-01-01T00:00:00.000Z', kind: 'session_open', status: 'approved' }),
      rec({ agent_id: 'a', session_id: 's1', ts: '2026-01-01T00:00:01.000Z', kind: 'tool_call', status: 'pending', tool: { name: 'foo', args: {} } }),
      rec({ agent_id: 'a', session_id: 's1', ts: '2026-01-01T00:00:02.000Z', kind: 'tool_result', status: 'executed' }),
      rec({ agent_id: 'a', session_id: 's2', ts: '2026-01-01T01:00:00.000Z', kind: 'tool_call', status: 'pending', tool: { name: 'bar', args: {} } }),
    ];
    const p = analyzeAgent(records, 'a');
    expect(p.total_records).toBe(4);
    expect(p.session_count).toBe(2);
    expect(p.tool_call_count).toBe(2);
    expect(p.tool_frequency).toEqual({ foo: 1, bar: 1 });
  });

  it('computes session-length stats', () => {
    const records: AuditRecord[] = [
      // session s1: 3 events
      rec({ agent_id: 'a', session_id: 's1', ts: '2026-01-01T00:00:00.000Z', kind: 'tool_call', status: 'pending' }),
      rec({ agent_id: 'a', session_id: 's1', ts: '2026-01-01T00:00:01.000Z', kind: 'tool_call', status: 'pending' }),
      rec({ agent_id: 'a', session_id: 's1', ts: '2026-01-01T00:00:02.000Z', kind: 'tool_call', status: 'pending' }),
      // session s2: 1 event
      rec({ agent_id: 'a', session_id: 's2', ts: '2026-01-01T01:00:00.000Z', kind: 'tool_call', status: 'pending' }),
    ];
    const p = analyzeAgent(records, 'a');
    expect(p.avg_session_length_events).toBe(2); // (3 + 1) / 2
    expect(p.stddev_session_length_events).toBe(1); // |3-2|=1, |1-2|=1 → σ=1
  });

  it('computes session-duration stats from min/max ts', () => {
    const records: AuditRecord[] = [
      rec({ agent_id: 'a', session_id: 's1', ts: '2026-01-01T00:00:00.000Z', kind: 'tool_call', status: 'pending' }),
      rec({ agent_id: 'a', session_id: 's1', ts: '2026-01-01T00:00:05.000Z', kind: 'tool_call', status: 'pending' }),
    ];
    const p = analyzeAgent(records, 'a');
    expect(p.avg_session_duration_ms).toBe(5000);
  });

  it('hour_of_day buckets by UTC hour', () => {
    const records: AuditRecord[] = [
      rec({ agent_id: 'a', session_id: 's', ts: '2026-01-01T03:00:00.000Z', kind: 'tool_call', status: 'pending' }),
      rec({ agent_id: 'a', session_id: 's', ts: '2026-01-01T03:30:00.000Z', kind: 'tool_call', status: 'pending' }),
      rec({ agent_id: 'a', session_id: 's', ts: '2026-01-01T15:00:00.000Z', kind: 'tool_call', status: 'pending' }),
    ];
    const p = analyzeAgent(records, 'a');
    expect(p.hour_of_day).toHaveLength(24);
    expect(p.hour_of_day[3]).toBe(2);
    expect(p.hour_of_day[15]).toBe(1);
  });

  it('tracks kind + status frequencies', () => {
    const records: AuditRecord[] = [
      rec({ agent_id: 'a', session_id: 's', ts: '2026-01-01T00:00:00.000Z', kind: 'tool_call', status: 'pending' }),
      rec({ agent_id: 'a', session_id: 's', ts: '2026-01-01T00:00:01.000Z', kind: 'tool_result', status: 'executed' }),
      rec({ agent_id: 'a', session_id: 's', ts: '2026-01-01T00:00:02.000Z', kind: 'tool_result', status: 'errored' }),
    ];
    const p = analyzeAgent(records, 'a');
    expect(p.kind_frequency).toEqual({ tool_call: 1, tool_result: 2 });
    expect(p.status_frequency).toEqual({ pending: 1, executed: 1, errored: 1 });
  });

  it('records first_ts and last_ts', () => {
    const records: AuditRecord[] = [
      rec({ agent_id: 'a', session_id: 's', ts: '2026-02-15T10:00:00.000Z', kind: 'tool_call', status: 'pending' }),
      rec({ agent_id: 'a', session_id: 's', ts: '2026-01-01T00:00:00.000Z', kind: 'tool_call', status: 'pending' }),
      rec({ agent_id: 'a', session_id: 's', ts: '2026-03-01T05:00:00.000Z', kind: 'tool_call', status: 'pending' }),
    ];
    const p = analyzeAgent(records, 'a');
    expect(p.first_ts).toBe('2026-01-01T00:00:00.000Z');
    expect(p.last_ts).toBe('2026-03-01T05:00:00.000Z');
  });

  it('handles invalid ts gracefully (NaN hour does not corrupt the bucket array)', () => {
    const records: AuditRecord[] = [
      rec({ agent_id: 'a', session_id: 's', ts: 'not-a-timestamp', kind: 'tool_call', status: 'pending' }),
    ];
    const p = analyzeAgent(records, 'a');
    expect(p.hour_of_day.every((c) => typeof c === 'number')).toBe(true);
  });

  it('single-record session yields duration 0', () => {
    const records: AuditRecord[] = [
      rec({ agent_id: 'a', session_id: 's', ts: '2026-01-01T00:00:00.000Z', kind: 'tool_call', status: 'pending' }),
    ];
    const p = analyzeAgent(records, 'a');
    expect(p.avg_session_duration_ms).toBe(0);
  });
});

describe('analyzeMultiAgent', () => {
  it('buckets by agent_id and produces one profile per agent', () => {
    const records: AuditRecord[] = [
      rec({ agent_id: 'a', session_id: 's', ts: '2026-01-01T00:00:00.000Z', kind: 'tool_call', status: 'pending' }),
      rec({ agent_id: 'b', session_id: 's', ts: '2026-01-01T00:00:00.000Z', kind: 'tool_call', status: 'pending' }),
      rec({ agent_id: 'a', session_id: 's', ts: '2026-01-01T00:00:01.000Z', kind: 'tool_call', status: 'pending' }),
    ];
    const m = analyzeMultiAgent(records);
    expect(m.size).toBe(2);
    expect(m.get('a')?.total_records).toBe(2);
    expect(m.get('b')?.total_records).toBe(1);
  });
});

describe('compareToBaseline', () => {
  const baseline = {
    v: '1' as const,
    agent_id: 'a',
    session_count: 10,
    total_records: 100,
    tool_call_count: 50,
    avg_session_length_events: 10,
    stddev_session_length_events: 2,
    avg_session_duration_ms: 5000,
    stddev_session_duration_ms: 1000,
    tool_frequency: { read: 30, write: 20 },
    hour_of_day: new Array<number>(24).fill(0),
    kind_frequency: {},
    status_frequency: {},
    first_ts: '2026-01-01T00:00:00.000Z',
    last_ts: '2026-01-10T00:00:00.000Z',
    generated_at: '2026-01-11T00:00:00.000Z',
  };

  it('flags session length deviation above σ threshold', () => {
    const candidate = { ...baseline, avg_session_length_events: 100 }; // 45σ
    const report = compareToBaseline(candidate, baseline);
    expect(report.deviations.some((d) => d.metric === 'avg_session_length_events')).toBe(true);
  });

  it('does not flag within-threshold deviations', () => {
    const candidate = { ...baseline, avg_session_length_events: 11 }; // 0.5σ
    const report = compareToBaseline(candidate, baseline);
    expect(report.deviations.length).toBe(0);
  });

  it('flags new tools not in baseline', () => {
    const candidate = { ...baseline, tool_frequency: { read: 30, write: 20, delete_all: 5 } };
    const report = compareToBaseline(candidate, baseline);
    expect(report.deviations.find((d) => d.metric === 'tool_frequency.delete_all')).toBeDefined();
  });

  it('skips σ checks when baseline has too few sessions', () => {
    const sparse = { ...baseline, session_count: 1 };
    const candidate = { ...baseline, session_count: 1, avg_session_length_events: 999 };
    const report = compareToBaseline(candidate, sparse);
    // Tool deviations still considered; session-length not.
    expect(report.deviations.find((d) => d.metric === 'avg_session_length_events')).toBeUndefined();
  });

  it('flags any difference when baseline σ=0', () => {
    const fixedBase = { ...baseline, stddev_session_length_events: 0 };
    const candidate = { ...baseline, avg_session_length_events: 11 };
    const report = compareToBaseline(candidate, fixedBase);
    const d = report.deviations.find((d) => d.metric === 'avg_session_length_events');
    expect(d?.sigma).toBeNull();
  });

  it('respects custom sigmaThreshold', () => {
    const candidate = { ...baseline, avg_session_length_events: 15 }; // 2.5σ
    const lenient = compareToBaseline(candidate, baseline, { sigmaThreshold: 3 });
    expect(lenient.deviations.find((d) => d.metric === 'avg_session_length_events')).toBeUndefined();
    const tight = compareToBaseline(candidate, baseline, { sigmaThreshold: 2 });
    expect(tight.deviations.find((d) => d.metric === 'avg_session_length_events')).toBeDefined();
  });

  it('reports zero deviations when baseline σ=0 and observed === baseline mean', () => {
    const fixedBase = { ...baseline, stddev_session_length_events: 0 };
    const candidate = { ...baseline };
    const report = compareToBaseline(candidate, fixedBase);
    expect(report.deviations.find((d) => d.metric === 'avg_session_length_events')).toBeUndefined();
  });

  it('returns deviations sorted by metric name for stable output', () => {
    const candidate = {
      ...baseline,
      avg_session_length_events: 100,
      avg_session_duration_ms: 100_000,
    };
    const report = compareToBaseline(candidate, baseline);
    const names = report.deviations.map((d) => d.metric);
    expect(names).toEqual([...names].sort());
  });
});
