#!/usr/bin/env node
/**
 * guardian-baseline — offline behavioral-baseline CLI. SPEC §13 (v0.5.0+).
 *
 * Usage:
 *   guardian-baseline <jsonl>                          # build profile(s), write to ~/.flowdot/audit/baselines/<agent>.json
 *   guardian-baseline <jsonl> --agent <id>             # restrict to one agent_id
 *   guardian-baseline <jsonl> --out <path>             # custom output path
 *   guardian-baseline <jsonl> --check                  # compare jsonl against existing baseline(s); report deviations
 *   guardian-baseline <jsonl> --check --sigma <N>      # custom σ threshold (default 3)
 *
 * Exit codes:
 *   0 — success (profile written, or --check found zero deviations)
 *   1 — IO error / bad JSONL / --check found deviations
 *   2 — usage error (bad args)
 *
 * NOT A RUNTIME TRIPWIRE. Output is for operator review. The supervisor
 * never consults baselines in the hot path.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { AuditLogReader } from '../audit/reader.js';
import {
  analyzeMultiAgent,
  compareToBaseline,
  type AgentProfile,
  type DeviationReport,
} from '../audit/stats.js';

export interface BaselineArgs {
  path: string | undefined;
  agent: string | undefined;
  out: string | undefined;
  check: boolean;
  sigma: number;
}

/** Parse argv. Returns the parsed args or null on usage error. */
export function parseArgs(argv: readonly string[]): BaselineArgs | null {
  const args = argv.slice();
  let path: string | undefined;
  let agent: string | undefined;
  let out: string | undefined;
  let check = false;
  let sigma = 3;

  while (args.length > 0) {
    const a = args.shift();
    /* c8 ignore next */
    if (a === undefined) break;
    if (a === '--agent') {
      agent = args.shift();
      if (agent === undefined) return null;
    } else if (a === '--out') {
      out = args.shift();
      if (out === undefined) return null;
    } else if (a === '--check') {
      check = true;
    } else if (a === '--sigma') {
      const v = args.shift();
      if (v === undefined) return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) return null;
      sigma = n;
    } else if (a.startsWith('--')) {
      return null;
    } else if (path === undefined) {
      path = a;
    } else {
      return null;
    }
  }
  if (path === undefined) return null;
  return { path, agent, out, check, sigma };
}

/** Default baselines directory: `~/.flowdot/audit/baselines/`. */
export function defaultBaselinesDir(): string {
  return process.env.FLOWDOT_BASELINES_DIR ?? join(homedir(), '.flowdot', 'audit', 'baselines');
}

function baselinePath(agentId: string, baselinesDir: string): string {
  // ASCII-safe filename derived from agent_id. agent_id is already
  // expected to be short + ASCII per SPEC; we sanitize defensively.
  const safe = agentId.replace(/[^a-zA-Z0-9._-]/g, '_');
  return join(baselinesDir, `${safe}.json`);
}

export interface BaselineRunResult {
  exitCode: 0 | 1 | 2;
  message: string;
  profilesWritten: string[];
  reports: DeviationReport[];
}

/**
 * Read an audit JSONL file and return one record per non-empty line.
 * Caller is responsible for filtering by agent_id.
 */
async function loadRecords(
  path: string,
): Promise<Awaited<ReturnType<typeof readAll>>> {
  const reader = await AuditLogReader.open(path);
  try {
    return await readAll(reader);
  } finally {
    await reader.close();
  }
}

async function readAll(
  reader: AuditLogReader,
): Promise<import('../types.js').AuditRecord[]> {
  const out: import('../types.js').AuditRecord[] = [];
  for await (const r of reader.records()) out.push(r);
  return out;
}

/** Programmatic entry point — useful for tests and library consumers. */
export async function runBaseline(args: BaselineArgs): Promise<BaselineRunResult> {
  if (!args.path) {
    return { exitCode: 2, message: 'missing path', profilesWritten: [], reports: [] };
  }
  if (!existsSync(args.path)) {
    return {
      exitCode: 1,
      message: `audit file not found: ${args.path}`,
      profilesWritten: [],
      reports: [],
    };
  }
  let records: import('../types.js').AuditRecord[];
  try {
    records = await loadRecords(args.path);
  } catch (err) {
    return {
      exitCode: 1,
      /* c8 ignore next */
      message: `failed to read audit file: ${err instanceof Error ? err.message : String(err)}`,
      profilesWritten: [],
      reports: [],
    };
  }

  const profiles = analyzeMultiAgent(records);
  const filteredProfiles = args.agent
    ? new Map([...profiles].filter(([id]) => id === args.agent))
    : profiles;
  if (filteredProfiles.size === 0) {
    return {
      exitCode: 1,
      message: args.agent
        ? `no records for agent_id ${JSON.stringify(args.agent)}`
        : 'no records found in audit file',
      profilesWritten: [],
      reports: [],
    };
  }

  const baselinesDir = args.out ? dirname(args.out) : defaultBaselinesDir();

  // --check path: compare each candidate profile against the existing baseline.
  if (args.check) {
    const reports: DeviationReport[] = [];
    for (const [agentId, profile] of filteredProfiles) {
      const baseFile = args.out ?? baselinePath(agentId, baselinesDir);
      if (!existsSync(baseFile)) {
        return {
          exitCode: 1,
          message: `no baseline for ${agentId} at ${baseFile} — run without --check first to produce one`,
          profilesWritten: [],
          reports,
        };
      }
      let baseline: AgentProfile;
      try {
        baseline = JSON.parse(readFileSync(baseFile, 'utf-8')) as AgentProfile;
      } catch (err) {
        return {
          exitCode: 1,
          /* c8 ignore next */
          message: `failed to read baseline ${baseFile}: ${err instanceof Error ? err.message : String(err)}`,
          profilesWritten: [],
          reports,
        };
      }
      reports.push(
        compareToBaseline(profile, baseline, { sigmaThreshold: args.sigma }),
      );
    }
    const totalDeviations = reports.reduce((s, r) => s + r.deviations.length, 0);
    return {
      exitCode: totalDeviations === 0 ? 0 : 1,
      message:
        totalDeviations === 0
          ? `OK: ${reports.length} agent(s) checked, no deviations at σ=${args.sigma}`
          : `${totalDeviations} deviation(s) across ${reports.length} agent(s) at σ=${args.sigma}`,
      profilesWritten: [],
      reports,
    };
  }

  // Write path: persist profiles to disk.
  if (args.out && filteredProfiles.size > 1) {
    return {
      exitCode: 2,
      message: '--out requires --agent when the file contains multiple agent_ids',
      profilesWritten: [],
      reports: [],
    };
  }
  if (!existsSync(baselinesDir)) {
    mkdirSync(baselinesDir, { recursive: true, mode: 0o700 });
  }
  const written: string[] = [];
  for (const [agentId, profile] of filteredProfiles) {
    const file = args.out ?? baselinePath(agentId, baselinesDir);
    writeFileSync(file, JSON.stringify(profile, null, 2) + '\n', { mode: 0o600 });
    written.push(file);
  }
  return {
    exitCode: 0,
    message: `wrote ${written.length} baseline(s)`,
    profilesWritten: written,
    reports: [],
  };
}

/** Render a deviation report as human-readable text. */
export function formatReport(report: DeviationReport): string {
  if (report.deviations.length === 0) {
    return `[${report.agent_id}] no deviations.`;
  }
  const lines = [`[${report.agent_id}] ${report.deviations.length} deviation(s):`];
  for (const d of report.deviations) {
    const sigmaStr = d.sigma === null ? 'σ=n/a' : `σ=${d.sigma.toFixed(2)}`;
    lines.push(`  - ${d.metric}: observed=${d.observed}, baseline=${d.baseline}, ${sigmaStr} — ${d.note}`);
  }
  return lines.join('\n');
}

const USAGE = `Usage:
  guardian-baseline <jsonl>                          # build profile(s)
  guardian-baseline <jsonl> --agent <id>             # restrict to one agent_id
  guardian-baseline <jsonl> --out <path>             # custom output path
  guardian-baseline <jsonl> --check                  # compare against existing baseline(s)
  guardian-baseline <jsonl> --check --sigma <N>      # custom σ threshold (default 3)

Exit codes:
  0 — success (profile written, or --check found zero deviations)
  1 — IO error / bad JSONL / --check found deviations
  2 — usage error
`;

/* c8 ignore start */
async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) {
    process.stderr.write(USAGE);
    process.exit(2);
  }
  const result = await runBaseline(parsed);
  if (parsed.check) {
    for (const r of result.reports) {
      process.stdout.write(formatReport(r) + '\n');
    }
  } else {
    for (const p of result.profilesWritten) {
      process.stdout.write(`wrote ${p}\n`);
    }
  }
  if (result.exitCode !== 0) {
    process.stderr.write(result.message + '\n');
  }
  process.exit(result.exitCode);
}
/* c8 ignore stop */

// Run as CLI when invoked directly (not when imported as a module).
const isMain =
  typeof process !== 'undefined' &&
  typeof process.argv !== 'undefined' &&
  process.argv[1] !== undefined &&
  /guardian-baseline(\.js|\.ts)?$/.test(process.argv[1]);
/* c8 ignore start */
if (isMain) {
  void main();
}
/* c8 ignore stop */
