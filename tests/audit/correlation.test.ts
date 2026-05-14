import { describe, expect, it } from 'vitest';

import {
  correlate,
  findArgsHashCollisions,
  findOverlappingSessions,
  findSequenceSimilarity,
  summarizeSessions,
  type AuditSource,
} from '../../src/audit/correlation.js';
import type { AuditRecord } from '../../src/types.js';

function rec(p: {
  agent_id: string;
  session_id: string;
  ts: string;
  kind: AuditRecord['kind'];
  status: AuditRecord['status'];
  tool?: { name: string; args: Record<string, unknown> };
  event_id?: string;
}): AuditRecord {
  return {
    v: '0.2.0',
    event_id: p.event_id ?? `evt_${p.session_id}_${p.ts}`,
    initiator: 'agent',
    prev_hash: 'sha256:0',
    agent_id: p.agent_id,
    session_id: p.session_id,
    ts: p.ts,
    kind: p.kind,
    status: p.status,
    ...(p.tool ? { tool: p.tool } : {}),
  };
}

describe('summarizeSessions', () => {
  it('produces one summary per (agent_id, session_id)', () => {
    const src: AuditSource = {
      surface: 'cli',
      records: [
        rec({ agent_id: 'a', session_id: 's1', ts: '2026-01-01T00:00:00.000Z', kind: 'session_open', status: 'approved' }),
        rec({ agent_id: 'a', session_id: 's1', ts: '2026-01-01T00:00:05.000Z', kind: 'session_close', status: 'approved' }),
        rec({ agent_id: 'a', session_id: 's2', ts: '2026-01-01T01:00:00.000Z', kind: 'session_open', status: 'approved' }),
      ],
    };
    const summaries = summarizeSessions(src);
    expect(summaries).toHaveLength(2);
    const s1 = summaries.find((s) => s.session_id === 's1')!;
    expect(s1.duration_ms).toBe(5000);
  });

  it('handles out-of-order timestamps when computing min/max', () => {
    const src: AuditSource = {
      surface: 'cli',
      records: [
        // First record seen has the LATER ts.
        rec({ agent_id: 'a', session_id: 's', ts: '2026-01-01T00:00:05.000Z', kind: 'session_open', status: 'approved' }),
        // Second record has an EARLIER ts — must update start.
        rec({ agent_id: 'a', session_id: 's', ts: '2026-01-01T00:00:01.000Z', kind: 'session_close', status: 'approved' }),
      ],
    };
    const s = summarizeSessions(src)[0]!;
    expect(s.start).toBe('2026-01-01T00:00:01.000Z');
    expect(s.end).toBe('2026-01-01T00:00:05.000Z');
  });

  it('captures tool_frequency + args_hashes', () => {
    const src: AuditSource = {
      surface: 'cli',
      records: [
        rec({
          agent_id: 'a',
          session_id: 's',
          ts: '2026-01-01T00:00:00.000Z',
          kind: 'tool_call',
          status: 'pending',
          tool: { name: 'foo', args: { x: 1 } },
        }),
        rec({
          agent_id: 'a',
          session_id: 's',
          ts: '2026-01-01T00:00:01.000Z',
          kind: 'tool_call',
          status: 'pending',
          tool: { name: 'foo', args: { x: 1 } },
        }),
      ],
    };
    const s = summarizeSessions(src)[0]!;
    expect(s.tool_frequency).toEqual({ foo: 2 });
    expect(s.args_hashes).toHaveLength(2);
    // Identical args ⇒ identical hash.
    expect(s.args_hashes[0]!.args_hash).toBe(s.args_hashes[1]!.args_hash);
  });
});

describe('findOverlappingSessions', () => {
  it('detects two surfaces with overlapping time windows', () => {
    const sessions = [
      ...summarizeSessions({
        surface: 'cli',
        records: [
          rec({ agent_id: 'a', session_id: 'sA', ts: '2026-01-01T00:00:00.000Z', kind: 'session_open', status: 'approved' }),
          rec({ agent_id: 'a', session_id: 'sA', ts: '2026-01-01T00:00:30.000Z', kind: 'session_close', status: 'approved' }),
        ],
      }),
      ...summarizeSessions({
        surface: 'mcp',
        records: [
          rec({ agent_id: 'a', session_id: 'sB', ts: '2026-01-01T00:00:10.000Z', kind: 'session_open', status: 'approved' }),
          rec({ agent_id: 'a', session_id: 'sB', ts: '2026-01-01T00:00:40.000Z', kind: 'session_close', status: 'approved' }),
        ],
      }),
    ];
    const matches = findOverlappingSessions(sessions);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.match_type).toBe('overlapping_sessions');
    expect(matches[0]!.detail.overlap_ms).toBe(20_000);
  });

  it('does NOT match when sessions are on the same surface', () => {
    const sessions = summarizeSessions({
      surface: 'cli',
      records: [
        rec({ agent_id: 'a', session_id: 'sA', ts: '2026-01-01T00:00:00.000Z', kind: 'session_open', status: 'approved' }),
        rec({ agent_id: 'a', session_id: 'sA', ts: '2026-01-01T00:00:30.000Z', kind: 'session_close', status: 'approved' }),
        rec({ agent_id: 'a', session_id: 'sB', ts: '2026-01-01T00:00:10.000Z', kind: 'session_open', status: 'approved' }),
        rec({ agent_id: 'a', session_id: 'sB', ts: '2026-01-01T00:00:40.000Z', kind: 'session_close', status: 'approved' }),
      ],
    });
    expect(findOverlappingSessions(sessions)).toEqual([]);
  });

  it('does NOT match when windows do not overlap', () => {
    const sessions = [
      ...summarizeSessions({
        surface: 'cli',
        records: [
          rec({ agent_id: 'a', session_id: 'sA', ts: '2026-01-01T00:00:00.000Z', kind: 'session_open', status: 'approved' }),
          rec({ agent_id: 'a', session_id: 'sA', ts: '2026-01-01T00:00:30.000Z', kind: 'session_close', status: 'approved' }),
        ],
      }),
      ...summarizeSessions({
        surface: 'mcp',
        records: [
          rec({ agent_id: 'a', session_id: 'sB', ts: '2026-01-01T00:01:00.000Z', kind: 'session_open', status: 'approved' }),
          rec({ agent_id: 'a', session_id: 'sB', ts: '2026-01-01T00:01:30.000Z', kind: 'session_close', status: 'approved' }),
        ],
      }),
    ];
    expect(findOverlappingSessions(sessions)).toEqual([]);
  });
});

describe('findArgsHashCollisions', () => {
  it('detects identical-args calls across surfaces within window', () => {
    const sessions = [
      ...summarizeSessions({
        surface: 'cli',
        records: [
          rec({
            agent_id: 'a',
            session_id: 's1',
            ts: '2026-01-01T00:00:00.000Z',
            kind: 'tool_call',
            status: 'pending',
            tool: { name: 'send', args: { to: 'x@y' } },
          }),
        ],
      }),
      ...summarizeSessions({
        surface: 'mcp',
        records: [
          rec({
            agent_id: 'a',
            session_id: 's2',
            ts: '2026-01-01T00:00:05.000Z',
            kind: 'tool_call',
            status: 'pending',
            tool: { name: 'send', args: { to: 'x@y' } },
          }),
        ],
      }),
    ];
    const matches = findArgsHashCollisions(sessions, 60_000);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.detail.tool_name).toBe('send');
  });

  it('does NOT match when window exceeded', () => {
    const sessions = [
      ...summarizeSessions({
        surface: 'cli',
        records: [
          rec({
            agent_id: 'a',
            session_id: 's1',
            ts: '2026-01-01T00:00:00.000Z',
            kind: 'tool_call',
            status: 'pending',
            tool: { name: 'send', args: { to: 'x@y' } },
          }),
        ],
      }),
      ...summarizeSessions({
        surface: 'mcp',
        records: [
          rec({
            agent_id: 'a',
            session_id: 's2',
            ts: '2026-01-01T00:10:00.000Z', // 10 min later
            kind: 'tool_call',
            status: 'pending',
            tool: { name: 'send', args: { to: 'x@y' } },
          }),
        ],
      }),
    ];
    expect(findArgsHashCollisions(sessions, 60_000)).toEqual([]);
  });

  it('does NOT match when surfaces are the same', () => {
    const sessions = summarizeSessions({
      surface: 'cli',
      records: [
        rec({
          agent_id: 'a',
          session_id: 's1',
          ts: '2026-01-01T00:00:00.000Z',
          kind: 'tool_call',
          status: 'pending',
          tool: { name: 'send', args: { to: 'x@y' } },
        }),
        rec({
          agent_id: 'a',
          session_id: 's2',
          ts: '2026-01-01T00:00:05.000Z',
          kind: 'tool_call',
          status: 'pending',
          tool: { name: 'send', args: { to: 'x@y' } },
        }),
      ],
    });
    expect(findArgsHashCollisions(sessions, 60_000)).toEqual([]);
  });

  it('does NOT match when tool names differ', () => {
    const sessions = [
      ...summarizeSessions({
        surface: 'cli',
        records: [
          rec({
            agent_id: 'a',
            session_id: 's1',
            ts: '2026-01-01T00:00:00.000Z',
            kind: 'tool_call',
            status: 'pending',
            tool: { name: 'send', args: { to: 'x@y' } },
          }),
        ],
      }),
      ...summarizeSessions({
        surface: 'mcp',
        records: [
          rec({
            agent_id: 'a',
            session_id: 's2',
            ts: '2026-01-01T00:00:05.000Z',
            kind: 'tool_call',
            status: 'pending',
            tool: { name: 'read', args: { to: 'x@y' } },
          }),
        ],
      }),
    ];
    expect(findArgsHashCollisions(sessions, 60_000)).toEqual([]);
  });
});

describe('findSequenceSimilarity', () => {
  const opts = {
    argsHashWindowMs: 60_000,
    similarityThreshold: 0.9,
    similarityWindowMs: 600_000,
    similarityMinCalls: 3,
  };

  function manyCalls(surface: string, sessionId: string, baseTs: string, tools: string[]): AuditSource {
    return {
      surface,
      records: tools.map((name, i) =>
        rec({
          agent_id: 'a',
          session_id: sessionId,
          ts: new Date(new Date(baseTs).getTime() + i * 1000).toISOString(),
          kind: 'tool_call',
          status: 'pending',
          tool: { name, args: { i } },
          event_id: `evt-${surface}-${i}`,
        }),
      ),
    };
  }

  it('detects two surfaces with near-identical tool-frequency vectors in window', () => {
    const sessions = [
      ...summarizeSessions(manyCalls('cli', 's1', '2026-01-01T00:00:00.000Z', ['read', 'read', 'write', 'write'])),
      ...summarizeSessions(manyCalls('mcp', 's2', '2026-01-01T00:00:30.000Z', ['read', 'read', 'write', 'write'])),
    ];
    const matches = findSequenceSimilarity(sessions, opts);
    expect(matches).toHaveLength(1);
    expect((matches[0]!.detail.cosine_similarity as number)).toBeCloseTo(1, 5);
  });

  it('does NOT match when sessions are sparse (< similarityMinCalls)', () => {
    const sessions = [
      ...summarizeSessions(manyCalls('cli', 's1', '2026-01-01T00:00:00.000Z', ['read'])),
      ...summarizeSessions(manyCalls('mcp', 's2', '2026-01-01T00:00:30.000Z', ['read'])),
    ];
    expect(findSequenceSimilarity(sessions, opts)).toEqual([]);
  });

  it('does NOT match when start times are outside similarityWindowMs', () => {
    const sessions = [
      ...summarizeSessions(manyCalls('cli', 's1', '2026-01-01T00:00:00.000Z', ['read', 'read', 'write', 'write'])),
      ...summarizeSessions(manyCalls('mcp', 's2', '2026-01-02T00:00:00.000Z', ['read', 'read', 'write', 'write'])),
    ];
    expect(findSequenceSimilarity(sessions, opts)).toEqual([]);
  });

  it('does NOT match when vectors are orthogonal (different tool sets)', () => {
    const sessions = [
      ...summarizeSessions(manyCalls('cli', 's1', '2026-01-01T00:00:00.000Z', ['read', 'read', 'read'])),
      ...summarizeSessions(manyCalls('mcp', 's2', '2026-01-01T00:00:30.000Z', ['write', 'write', 'write'])),
    ];
    expect(findSequenceSimilarity(sessions, opts)).toEqual([]);
  });

  it('does NOT match same-surface pairs', () => {
    const sessions = summarizeSessions(
      manyCalls('cli', 's1', '2026-01-01T00:00:00.000Z', ['read', 'read', 'write', 'write']),
    );
    // Two sessions on same surface
    sessions.push(
      ...summarizeSessions(manyCalls('cli', 's2', '2026-01-01T00:00:30.000Z', ['read', 'read', 'write', 'write'])),
    );
    expect(findSequenceSimilarity(sessions, opts)).toEqual([]);
  });
});

describe('correlate', () => {
  it('runs all three correlators and produces matches across the right agent_id', () => {
    const sources: AuditSource[] = [
      {
        surface: 'cli',
        records: [
          rec({ agent_id: 'a', session_id: 's1', ts: '2026-01-01T00:00:00.000Z', kind: 'session_open', status: 'approved' }),
          rec({
            agent_id: 'a',
            session_id: 's1',
            ts: '2026-01-01T00:00:10.000Z',
            kind: 'tool_call',
            status: 'pending',
            tool: { name: 't', args: { v: 1 } },
          }),
          rec({ agent_id: 'a', session_id: 's1', ts: '2026-01-01T00:00:30.000Z', kind: 'session_close', status: 'approved' }),
        ],
      },
      {
        surface: 'mcp',
        records: [
          rec({ agent_id: 'a', session_id: 's2', ts: '2026-01-01T00:00:15.000Z', kind: 'session_open', status: 'approved' }),
          rec({
            agent_id: 'a',
            session_id: 's2',
            ts: '2026-01-01T00:00:20.000Z',
            kind: 'tool_call',
            status: 'pending',
            tool: { name: 't', args: { v: 1 } },
          }),
          rec({ agent_id: 'a', session_id: 's2', ts: '2026-01-01T00:00:45.000Z', kind: 'session_close', status: 'approved' }),
        ],
      },
    ];
    const matches = correlate(sources);
    const types = matches.map((m) => m.match_type).sort();
    expect(types).toContain('overlapping_sessions');
    expect(types).toContain('args_hash_collision');
  });

  it('honors custom options', () => {
    const sources: AuditSource[] = [
      {
        surface: 'cli',
        records: [
          rec({
            agent_id: 'a',
            session_id: 's1',
            ts: '2026-01-01T00:00:00.000Z',
            kind: 'tool_call',
            status: 'pending',
            tool: { name: 't', args: { v: 1 } },
          }),
        ],
      },
      {
        surface: 'mcp',
        records: [
          rec({
            agent_id: 'a',
            session_id: 's2',
            ts: '2026-01-01T00:02:00.000Z', // 2 min later
            kind: 'tool_call',
            status: 'pending',
            tool: { name: 't', args: { v: 1 } },
          }),
        ],
      },
    ];
    // Default window 60s — no match.
    expect(correlate(sources)).toEqual([]);
    // Widen to 5 min — matches.
    expect(correlate(sources, { argsHashWindowMs: 300_000 }).some((m) => m.match_type === 'args_hash_collision')).toBe(true);
  });
});
