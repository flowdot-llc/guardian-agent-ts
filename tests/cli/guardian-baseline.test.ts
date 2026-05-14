import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditLogWriter } from '../../src/audit/writer.js';
import {
  formatReport,
  parseArgs,
  runBaseline,
} from '../../src/cli/guardian-baseline.js';
import type { AgentProfile } from '../../src/audit/stats.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'baseline-cli-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Produce a small JSONL audit file at `path` for agent_id `a`. */
async function makeAuditFile(path: string, agentId = 'a'): Promise<void> {
  const w = new AuditLogWriter({ path, agentId, sessionId: 's1' });
  await w.append({ kind: 'session_open', status: 'approved', initiator: 'system' });
  await w.append({
    kind: 'tool_call',
    status: 'pending',
    initiator: 'agent',
    tool: { name: 'foo', args: {} },
  });
  await w.append({
    kind: 'tool_call',
    status: 'pending',
    initiator: 'agent',
    tool: { name: 'bar', args: {} },
  });
  await w.append({ kind: 'session_close', status: 'approved', initiator: 'system' });
  await w.close();
}

describe('parseArgs', () => {
  it('parses a bare path', () => {
    expect(parseArgs(['log.jsonl'])).toEqual({
      path: 'log.jsonl',
      agent: undefined,
      out: undefined,
      check: false,
      sigma: 3,
    });
  });

  it('parses --agent + --out + --check + --sigma', () => {
    expect(parseArgs(['log.jsonl', '--agent', 'a', '--out', 'p.json', '--check', '--sigma', '2'])).toEqual({
      path: 'log.jsonl',
      agent: 'a',
      out: 'p.json',
      check: true,
      sigma: 2,
    });
  });

  it('returns null when no path is given', () => {
    expect(parseArgs(['--agent', 'a'])).toBeNull();
  });

  it('returns null on unknown flag', () => {
    expect(parseArgs(['log.jsonl', '--unknown'])).toBeNull();
  });

  it('returns null on --agent without value', () => {
    expect(parseArgs(['log.jsonl', '--agent'])).toBeNull();
  });

  it('returns null on --out without value', () => {
    expect(parseArgs(['log.jsonl', '--out'])).toBeNull();
  });

  it('returns null on --sigma without value', () => {
    expect(parseArgs(['log.jsonl', '--sigma'])).toBeNull();
  });

  it('returns null on --sigma <= 0 or NaN', () => {
    expect(parseArgs(['log.jsonl', '--sigma', '0'])).toBeNull();
    expect(parseArgs(['log.jsonl', '--sigma', 'abc'])).toBeNull();
  });

  it('returns null on a stray positional after path', () => {
    expect(parseArgs(['a.jsonl', 'b.jsonl'])).toBeNull();
  });
});

describe('runBaseline — write path', () => {
  it('writes one profile per agent_id when no --agent specified', async () => {
    const log = join(tmp, 'audit.jsonl');
    await makeAuditFile(log, 'a');
    const result = await runBaseline({
      path: log,
      agent: undefined,
      out: undefined,
      check: false,
      sigma: 3,
    });
    expect(result.exitCode).toBe(0);
    expect(result.profilesWritten).toHaveLength(1);
    const profile = JSON.parse(readFileSync(result.profilesWritten[0]!, 'utf-8')) as AgentProfile;
    expect(profile.agent_id).toBe('a');
    expect(profile.total_records).toBe(4);
  });

  it('respects --agent filter', async () => {
    const log = join(tmp, 'audit.jsonl');
    // Build a log with two agents.
    const w1 = new AuditLogWriter({ path: log, agentId: 'a', sessionId: 'sa' });
    await w1.append({ kind: 'session_open', status: 'approved', initiator: 'system' });
    await w1.close();
    const w2 = new AuditLogWriter({ path: log, agentId: 'b', sessionId: 'sb' });
    await w2.append({ kind: 'session_open', status: 'approved', initiator: 'system' });
    await w2.close();

    const result = await runBaseline({
      path: log,
      agent: 'b',
      out: undefined,
      check: false,
      sigma: 3,
    });
    expect(result.exitCode).toBe(0);
    expect(result.profilesWritten).toHaveLength(1);
    const profile = JSON.parse(readFileSync(result.profilesWritten[0]!, 'utf-8')) as AgentProfile;
    expect(profile.agent_id).toBe('b');
  });

  it('writes to --out when specified (single agent)', async () => {
    const log = join(tmp, 'audit.jsonl');
    await makeAuditFile(log, 'a');
    const out = join(tmp, 'custom.json');
    const result = await runBaseline({
      path: log,
      agent: 'a',
      out,
      check: false,
      sigma: 3,
    });
    expect(result.exitCode).toBe(0);
    expect(result.profilesWritten).toEqual([out]);
  });

  it('rejects --out without --agent when multiple agents in file', async () => {
    const log = join(tmp, 'audit.jsonl');
    const w1 = new AuditLogWriter({ path: log, agentId: 'a', sessionId: 'sa' });
    await w1.append({ kind: 'session_open', status: 'approved', initiator: 'system' });
    await w1.close();
    const w2 = new AuditLogWriter({ path: log, agentId: 'b', sessionId: 'sb' });
    await w2.append({ kind: 'session_open', status: 'approved', initiator: 'system' });
    await w2.close();

    const result = await runBaseline({
      path: log,
      agent: undefined,
      out: join(tmp, 'x.json'),
      check: false,
      sigma: 3,
    });
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/--out requires --agent/);
  });

  it('exitCode 1 when audit file does not exist', async () => {
    const result = await runBaseline({
      path: join(tmp, 'nope.jsonl'),
      agent: undefined,
      out: undefined,
      check: false,
      sigma: 3,
    });
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/not found/);
  });

  it('exitCode 2 when path is missing entirely', async () => {
    const result = await runBaseline({
      path: undefined,
      agent: undefined,
      out: undefined,
      check: false,
      sigma: 3,
    });
    expect(result.exitCode).toBe(2);
  });

  it('exitCode 1 when no records match --agent', async () => {
    const log = join(tmp, 'audit.jsonl');
    await makeAuditFile(log, 'a');
    const result = await runBaseline({
      path: log,
      agent: 'nobody',
      out: undefined,
      check: false,
      sigma: 3,
    });
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/no records for agent_id/);
  });

  it('exitCode 1 when audit file is empty', async () => {
    const log = join(tmp, 'empty.jsonl');
    writeFileSync(log, '');
    const result = await runBaseline({
      path: log,
      agent: undefined,
      out: undefined,
      check: false,
      sigma: 3,
    });
    expect(result.exitCode).toBe(1);
  });

  it('exitCode 1 on malformed JSONL', async () => {
    const log = join(tmp, 'bad.jsonl');
    writeFileSync(log, 'not-json\n');
    const result = await runBaseline({
      path: log,
      agent: undefined,
      out: undefined,
      check: false,
      sigma: 3,
    });
    expect(result.exitCode).toBe(1);
  });

  it('creates the baselines directory when it does not yet exist', async () => {
    const log = join(tmp, 'audit.jsonl');
    await makeAuditFile(log, 'a');
    process.env.FLOWDOT_BASELINES_DIR = join(tmp, 'fresh-baselines-subdir');
    try {
      const result = await runBaseline({
        path: log,
        agent: 'a',
        out: undefined,
        check: false,
        sigma: 3,
      });
      expect(result.exitCode).toBe(0);
      expect(result.profilesWritten[0]).toMatch(/fresh-baselines-subdir/);
    } finally {
      delete process.env.FLOWDOT_BASELINES_DIR;
    }
  });

  it('sanitizes agent_id with shell-unsafe chars into the filename', async () => {
    const log = join(tmp, 'audit.jsonl');
    await makeAuditFile(log, 'agent/with/slashes');
    process.env.FLOWDOT_BASELINES_DIR = tmp;
    try {
      const result = await runBaseline({
        path: log,
        agent: undefined,
        out: undefined,
        check: false,
        sigma: 3,
      });
      expect(result.exitCode).toBe(0);
      expect(result.profilesWritten[0]).toMatch(/agent_with_slashes\.json$/);
    } finally {
      delete process.env.FLOWDOT_BASELINES_DIR;
    }
  });
});

describe('runBaseline — --check path', () => {
  it('exitCode 0 when no deviations', async () => {
    const log = join(tmp, 'audit.jsonl');
    await makeAuditFile(log, 'a');
    // Write a permissive baseline first.
    process.env.FLOWDOT_BASELINES_DIR = tmp;
    try {
      const write = await runBaseline({
        path: log,
        agent: 'a',
        out: undefined,
        check: false,
        sigma: 3,
      });
      expect(write.exitCode).toBe(0);
      // Same data → same profile → no deviations.
      const check = await runBaseline({
        path: log,
        agent: 'a',
        out: undefined,
        check: true,
        sigma: 3,
      });
      expect(check.exitCode).toBe(0);
      expect(check.reports[0]?.deviations).toEqual([]);
    } finally {
      delete process.env.FLOWDOT_BASELINES_DIR;
    }
  });

  it('exitCode 1 when --check finds deviations', async () => {
    const log = join(tmp, 'audit.jsonl');
    await makeAuditFile(log, 'a');
    process.env.FLOWDOT_BASELINES_DIR = tmp;
    try {
      await runBaseline({
        path: log,
        agent: 'a',
        out: undefined,
        check: false,
        sigma: 3,
      });
      // Build a different file with a new tool.
      const log2 = join(tmp, 'audit2.jsonl');
      const w = new AuditLogWriter({ path: log2, agentId: 'a', sessionId: 's2' });
      await w.append({ kind: 'session_open', status: 'approved', initiator: 'system' });
      await w.append({
        kind: 'tool_call',
        status: 'pending',
        initiator: 'agent',
        tool: { name: 'NEW_TOOL_NOT_IN_BASELINE', args: {} },
      });
      await w.close();

      const check = await runBaseline({
        path: log2,
        agent: 'a',
        out: undefined,
        check: true,
        sigma: 3,
      });
      expect(check.exitCode).toBe(1);
      expect(check.reports[0]?.deviations.length).toBeGreaterThan(0);
    } finally {
      delete process.env.FLOWDOT_BASELINES_DIR;
    }
  });

  it('--check returns exitCode 1 when no baseline exists for the agent', async () => {
    const log = join(tmp, 'audit.jsonl');
    await makeAuditFile(log, 'a');
    process.env.FLOWDOT_BASELINES_DIR = join(tmp, 'empty-dir');
    try {
      const result = await runBaseline({
        path: log,
        agent: 'a',
        out: undefined,
        check: true,
        sigma: 3,
      });
      expect(result.exitCode).toBe(1);
      expect(result.message).toMatch(/no baseline/);
    } finally {
      delete process.env.FLOWDOT_BASELINES_DIR;
    }
  });

  it('--check returns exitCode 1 when baseline file is malformed', async () => {
    const log = join(tmp, 'audit.jsonl');
    await makeAuditFile(log, 'a');
    process.env.FLOWDOT_BASELINES_DIR = tmp;
    writeFileSync(join(tmp, 'a.json'), 'not-json');
    try {
      const result = await runBaseline({
        path: log,
        agent: 'a',
        out: undefined,
        check: true,
        sigma: 3,
      });
      expect(result.exitCode).toBe(1);
      expect(result.message).toMatch(/failed to read baseline/);
    } finally {
      delete process.env.FLOWDOT_BASELINES_DIR;
    }
  });
});

describe('formatReport', () => {
  it('returns a one-line summary when there are no deviations', () => {
    expect(
      formatReport({
        agent_id: 'a',
        candidate_first_ts: null,
        candidate_last_ts: null,
        deviations: [],
      }),
    ).toMatch(/no deviations/);
  });

  it('lists each deviation on its own line', () => {
    const text = formatReport({
      agent_id: 'a',
      candidate_first_ts: null,
      candidate_last_ts: null,
      deviations: [
        { metric: 'foo', observed: 10, baseline: 1, sigma: 4.5, note: '4.5σ' },
        { metric: 'bar', observed: 1, baseline: 0, sigma: null, note: 'new' },
      ],
    });
    expect(text).toContain('foo');
    expect(text).toContain('bar');
    expect(text).toContain('σ=4.50');
    expect(text).toContain('σ=n/a');
  });
});
