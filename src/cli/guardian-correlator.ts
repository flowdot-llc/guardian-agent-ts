/**
 * guardian-correlator — offline cross-surface correlation CLI. SPEC §14
 * (v0.5.0+).
 *
 * Reads two or more audit JSONL files for the same `agent_id` and reports
 * patterns that span surfaces: overlapping sessions, identical-args
 * collisions, similar tool-frequency sequences. Writes findings as
 * `x_cross_surface_match` JSONL to its own log (NEVER mutates source
 * files).
 *
 * Usage:
 *   guardian-correlator <file1.jsonl>:<surface1> <file2.jsonl>:<surface2> [...]
 *   guardian-correlator <file1>:<surface1> <file2>:<surface2> --out <correlations.jsonl>
 *   guardian-correlator <files...> --threshold <0..1>   # cosine threshold (default 0.9)
 *   guardian-correlator <files...> --window-ms <N>      # args-hash window (default 60000)
 *
 * Exit codes:
 *   0 — success (matches written or none found; either way, exit 0)
 *   1 — IO error / bad JSONL
 *   2 — usage error
 *
 * Not a runtime tripwire. Output is for operator review.
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { AuditLogReader } from '../audit/reader.js';
import {
  correlate,
  type AuditSource,
  type CorrelationMatch,
  type CorrelationOptions,
} from '../audit/correlation.js';

export interface CorrelatorArgs {
  /** Tuples of (path, surface-name). */
  sources: { path: string; surface: string }[];
  out: string | undefined;
  threshold: number;
  argsHashWindowMs: number;
  similarityWindowMs: number;
  similarityMinCalls: number;
}

export function parseArgs(argv: readonly string[]): CorrelatorArgs | null {
  const args = argv.slice();
  const sources: { path: string; surface: string }[] = [];
  let out: string | undefined;
  let threshold = 0.9;
  let argsHashWindowMs = 60_000;
  let similarityWindowMs = 600_000;
  let similarityMinCalls = 5;

  while (args.length > 0) {
    const a = args.shift();
    /* c8 ignore next */
    if (a === undefined) break;
    if (a === '--out') {
      out = args.shift();
      if (out === undefined) return null;
    } else if (a === '--threshold') {
      const v = args.shift();
      if (v === undefined) return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 1) return null;
      threshold = n;
    } else if (a === '--window-ms') {
      const v = args.shift();
      if (v === undefined) return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) return null;
      argsHashWindowMs = n;
    } else if (a === '--similarity-window-ms') {
      const v = args.shift();
      if (v === undefined) return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) return null;
      similarityWindowMs = n;
    } else if (a === '--similarity-min-calls') {
      const v = args.shift();
      if (v === undefined) return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 1) return null;
      similarityMinCalls = n;
    } else if (a.startsWith('--')) {
      return null;
    } else {
      // Positional: path:surface
      const idx = a.lastIndexOf(':');
      if (idx <= 0 || idx === a.length - 1) return null;
      const path = a.slice(0, idx);
      const surface = a.slice(idx + 1);
      sources.push({ path, surface });
    }
  }
  if (sources.length < 2) return null;
  return {
    sources,
    out,
    threshold,
    argsHashWindowMs,
    similarityWindowMs,
    similarityMinCalls,
  };
}

export function defaultCorrelationsPath(): string {
  return process.env.FLOWDOT_CORRELATIONS_PATH ?? join(homedir(), '.flowdot', 'audit', 'correlations.jsonl');
}

export interface CorrelatorRunResult {
  exitCode: 0 | 1 | 2;
  message: string;
  matches: CorrelationMatch[];
  outPath: string | undefined;
}

async function loadSource(path: string, surface: string): Promise<AuditSource> {
  const reader = await AuditLogReader.open(path);
  try {
    const records = [];
    for await (const r of reader.records()) records.push(r);
    return { surface, records };
  } finally {
    await reader.close();
  }
}

export async function runCorrelator(args: CorrelatorArgs): Promise<CorrelatorRunResult> {
  for (const s of args.sources) {
    if (!existsSync(s.path)) {
      return {
        exitCode: 1,
        message: `audit file not found: ${s.path}`,
        matches: [],
        outPath: undefined,
      };
    }
  }
  // Load all sources.
  let sources: AuditSource[];
  try {
    sources = await Promise.all(args.sources.map((s) => loadSource(s.path, s.surface)));
  } catch (err) {
    return {
      exitCode: 1,
      /* c8 ignore next */
      message: `failed to read audit file: ${err instanceof Error ? err.message : String(err)}`,
      matches: [],
      outPath: undefined,
    };
  }

  const opts: CorrelationOptions = {
    argsHashWindowMs: args.argsHashWindowMs,
    similarityThreshold: args.threshold,
    similarityWindowMs: args.similarityWindowMs,
    similarityMinCalls: args.similarityMinCalls,
  };
  const matches = correlate(sources, opts);

  const outPath = args.out ?? defaultCorrelationsPath();
  const outDir = dirname(outPath);
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
  }
  // Append each match as one JSONL row with `ts` stamped at write time.
  if (matches.length > 0) {
    const lines = matches.map((m) => JSON.stringify({ ts: new Date().toISOString(), ...m }) + '\n').join('');
    // Create the file with 0o600 if it doesn't exist; otherwise append.
    if (!existsSync(outPath)) {
      writeFileSync(outPath, lines, { mode: 0o600 });
    } else {
      appendFileSync(outPath, lines);
    }
  }
  return {
    exitCode: 0,
    message:
      matches.length === 0
        ? `no cross-surface matches across ${sources.length} sources`
        : `wrote ${matches.length} match(es) to ${outPath}`,
    matches,
    outPath: matches.length === 0 ? undefined : outPath,
  };
}

const USAGE = `Usage:
  guardian-correlator <file1>:<surface1> <file2>:<surface2> [...]
  guardian-correlator <files...> [--out <correlations.jsonl>]
  guardian-correlator <files...> [--threshold <0..1>]              # cosine threshold (default 0.9)
  guardian-correlator <files...> [--window-ms <N>]                 # args-hash window (default 60000)
  guardian-correlator <files...> [--similarity-window-ms <N>]      # session-start window (default 600000)
  guardian-correlator <files...> [--similarity-min-calls <N>]      # min calls per session (default 5)

Exit codes:
  0 — success (matches written or none found)
  1 — IO error / bad JSONL
  2 — usage error
`;

/* c8 ignore start */
async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) {
    process.stderr.write(USAGE);
    process.exit(2);
  }
  const result = await runCorrelator(parsed);
  process.stdout.write(result.message + '\n');
  if (result.exitCode !== 0) {
    process.stderr.write(result.message + '\n');
  }
  process.exit(result.exitCode);
}
/* c8 ignore stop */

const isMain =
  typeof process !== 'undefined' &&
  typeof process.argv !== 'undefined' &&
  process.argv[1] !== undefined &&
  /guardian-correlator(\.js|\.ts)?$/.test(process.argv[1]);
/* c8 ignore start */
if (isMain) {
  void main();
}
/* c8 ignore stop */
