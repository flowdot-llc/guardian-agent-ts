import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditLogWriter } from '../../src/audit/writer.js';
import {
  defaultCorrelationsPath,
  parseArgs,
  runCorrelator,
} from '../../src/cli/guardian-correlator.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'corr-cli-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function makeFile(path: string, surface: 'cli' | 'mcp', sessionId: string): Promise<void> {
  const w = new AuditLogWriter({ path, agentId: 'a', sessionId });
  await w.append({ kind: 'session_open', status: 'approved', initiator: 'system' });
  await w.append({
    kind: 'tool_call',
    status: 'pending',
    initiator: 'agent',
    tool: { name: 'shared_tool', args: { x: 1 } },
  });
  await w.append({ kind: 'session_close', status: 'approved', initiator: 'system' });
  await w.close();
  void surface; // keep TS happy if unused
}

describe('parseArgs', () => {
  it('parses two sources with path:surface tuples', () => {
    const r = parseArgs(['cli.jsonl:cli', 'mcp.jsonl:mcp']);
    expect(r).toMatchObject({
      sources: [
        { path: 'cli.jsonl', surface: 'cli' },
        { path: 'mcp.jsonl', surface: 'mcp' },
      ],
      threshold: 0.9,
      argsHashWindowMs: 60_000,
    });
  });

  it('parses --out + numeric options', () => {
    const r = parseArgs([
      'a.jsonl:cli',
      'b.jsonl:mcp',
      '--out',
      '/tmp/out.jsonl',
      '--threshold',
      '0.95',
      '--window-ms',
      '120000',
      '--similarity-window-ms',
      '900000',
      '--similarity-min-calls',
      '10',
    ]);
    expect(r).toMatchObject({
      out: '/tmp/out.jsonl',
      threshold: 0.95,
      argsHashWindowMs: 120_000,
      similarityWindowMs: 900_000,
      similarityMinCalls: 10,
    });
  });

  it('rejects fewer than 2 sources', () => {
    expect(parseArgs(['cli.jsonl:cli'])).toBeNull();
    expect(parseArgs([])).toBeNull();
  });

  it('rejects malformed path:surface (no colon, or empty surface)', () => {
    expect(parseArgs(['cli.jsonl', 'mcp.jsonl:mcp'])).toBeNull();
    expect(parseArgs(['cli.jsonl:', 'mcp.jsonl:mcp'])).toBeNull();
    expect(parseArgs([':cli', 'mcp.jsonl:mcp'])).toBeNull();
  });

  it('rejects unknown flag', () => {
    expect(parseArgs(['a:cli', 'b:mcp', '--unknown'])).toBeNull();
  });

  it('rejects missing flag values', () => {
    expect(parseArgs(['a:cli', 'b:mcp', '--out'])).toBeNull();
    expect(parseArgs(['a:cli', 'b:mcp', '--threshold'])).toBeNull();
    expect(parseArgs(['a:cli', 'b:mcp', '--window-ms'])).toBeNull();
    expect(parseArgs(['a:cli', 'b:mcp', '--similarity-window-ms'])).toBeNull();
    expect(parseArgs(['a:cli', 'b:mcp', '--similarity-min-calls'])).toBeNull();
  });

  it('rejects bad numeric ranges', () => {
    expect(parseArgs(['a:cli', 'b:mcp', '--threshold', '1.5'])).toBeNull();
    expect(parseArgs(['a:cli', 'b:mcp', '--threshold', '-0.1'])).toBeNull();
    expect(parseArgs(['a:cli', 'b:mcp', '--threshold', 'NaN'])).toBeNull();
    expect(parseArgs(['a:cli', 'b:mcp', '--window-ms', '0'])).toBeNull();
    expect(parseArgs(['a:cli', 'b:mcp', '--similarity-window-ms', '-1'])).toBeNull();
    expect(parseArgs(['a:cli', 'b:mcp', '--similarity-min-calls', '0'])).toBeNull();
  });

  it('defaultCorrelationsPath honors env override, falls back to homedir', () => {
    const prev = process.env.FLOWDOT_CORRELATIONS_PATH;
    try {
      process.env.FLOWDOT_CORRELATIONS_PATH = '/custom/path.jsonl';
      expect(defaultCorrelationsPath()).toBe('/custom/path.jsonl');
      delete process.env.FLOWDOT_CORRELATIONS_PATH;
      expect(defaultCorrelationsPath()).toMatch(/correlations\.jsonl$/);
    } finally {
      if (prev === undefined) delete process.env.FLOWDOT_CORRELATIONS_PATH;
      else process.env.FLOWDOT_CORRELATIONS_PATH = prev;
    }
  });

  it('handles path:surface where path contains :', () => {
    // Windows-style path like `C:\Users\x\audit.jsonl`. The lastIndexOf(':')
    // splits on the surface separator at the END.
    const r = parseArgs(['C:\\path\\audit.jsonl:cli', 'D:\\other.jsonl:mcp']);
    expect(r?.sources[0]?.path).toBe('C:\\path\\audit.jsonl');
    expect(r?.sources[0]?.surface).toBe('cli');
  });
});

describe('runCorrelator', () => {
  it('returns exitCode 1 when a source file is missing', async () => {
    const result = await runCorrelator({
      sources: [
        { path: join(tmp, 'nope.jsonl'), surface: 'cli' },
        { path: join(tmp, 'also-nope.jsonl'), surface: 'mcp' },
      ],
      out: undefined,
      threshold: 0.9,
      argsHashWindowMs: 60_000,
      similarityWindowMs: 600_000,
      similarityMinCalls: 5,
    });
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/not found/);
  });

  it('returns exitCode 1 on malformed JSONL', async () => {
    const a = join(tmp, 'a.jsonl');
    const b = join(tmp, 'b.jsonl');
    writeFileSync(a, 'not-json\n');
    writeFileSync(b, 'still-not-json\n');
    const result = await runCorrelator({
      sources: [
        { path: a, surface: 'cli' },
        { path: b, surface: 'mcp' },
      ],
      out: undefined,
      threshold: 0.9,
      argsHashWindowMs: 60_000,
      similarityWindowMs: 600_000,
      similarityMinCalls: 5,
    });
    expect(result.exitCode).toBe(1);
  });

  it('exitCode 0 + no matches written when files have no cross-surface pattern', async () => {
    const a = join(tmp, 'a.jsonl');
    const b = join(tmp, 'b.jsonl');
    const w1 = new AuditLogWriter({ path: a, agentId: 'agentA', sessionId: 's' });
    await w1.append({ kind: 'session_open', status: 'approved', initiator: 'system' });
    await w1.close();
    const w2 = new AuditLogWriter({ path: b, agentId: 'agentB', sessionId: 's' });
    await w2.append({ kind: 'session_open', status: 'approved', initiator: 'system' });
    await w2.close();

    process.env.FLOWDOT_CORRELATIONS_PATH = join(tmp, 'corr.jsonl');
    try {
      const result = await runCorrelator({
        sources: [
          { path: a, surface: 'cli' },
          { path: b, surface: 'mcp' },
        ],
        out: undefined,
        threshold: 0.9,
        argsHashWindowMs: 60_000,
        similarityWindowMs: 600_000,
        similarityMinCalls: 5,
      });
      expect(result.exitCode).toBe(0);
      expect(result.matches).toEqual([]);
      // No output file written when there are no matches.
      expect(existsSync(join(tmp, 'corr.jsonl'))).toBe(false);
    } finally {
      delete process.env.FLOWDOT_CORRELATIONS_PATH;
    }
  });

  it('writes JSONL matches with ts field when correlations exist', async () => {
    const a = join(tmp, 'a.jsonl');
    const b = join(tmp, 'b.jsonl');
    await makeFile(a, 'cli', 's1');
    await makeFile(b, 'mcp', 's2');
    const out = join(tmp, 'correlations.jsonl');
    const result = await runCorrelator({
      sources: [
        { path: a, surface: 'cli' },
        { path: b, surface: 'mcp' },
      ],
      out,
      threshold: 0.9,
      argsHashWindowMs: 60_000,
      similarityWindowMs: 600_000,
      similarityMinCalls: 5,
    });
    expect(result.exitCode).toBe(0);
    expect(result.matches.length).toBeGreaterThan(0);
    expect(existsSync(out)).toBe(true);
    const lines = readFileSync(out, 'utf-8').split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBe(result.matches.length);
    for (const line of lines) {
      const obj = JSON.parse(line);
      expect(obj.kind).toBe('x_cross_surface_match');
      expect(typeof obj.ts).toBe('string');
    }
  });

  it('appends to an existing correlations file', async () => {
    const a = join(tmp, 'a.jsonl');
    const b = join(tmp, 'b.jsonl');
    await makeFile(a, 'cli', 's1');
    await makeFile(b, 'mcp', 's2');
    const out = join(tmp, 'corr.jsonl');
    writeFileSync(out, '{"existing":"row"}\n');
    const result = await runCorrelator({
      sources: [
        { path: a, surface: 'cli' },
        { path: b, surface: 'mcp' },
      ],
      out,
      threshold: 0.9,
      argsHashWindowMs: 60_000,
      similarityWindowMs: 600_000,
      similarityMinCalls: 5,
    });
    expect(result.exitCode).toBe(0);
    const text = readFileSync(out, 'utf-8');
    expect(text.startsWith('{"existing":"row"}')).toBe(true);
    expect(text.split('\n').length).toBeGreaterThan(2);
  });

  it('creates the output directory when it does not exist', async () => {
    const a = join(tmp, 'a.jsonl');
    const b = join(tmp, 'b.jsonl');
    await makeFile(a, 'cli', 's1');
    await makeFile(b, 'mcp', 's2');
    const out = join(tmp, 'new-dir', 'corr.jsonl');
    const result = await runCorrelator({
      sources: [
        { path: a, surface: 'cli' },
        { path: b, surface: 'mcp' },
      ],
      out,
      threshold: 0.9,
      argsHashWindowMs: 60_000,
      similarityWindowMs: 600_000,
      similarityMinCalls: 5,
    });
    expect(result.exitCode).toBe(0);
    expect(existsSync(out)).toBe(true);
  });
});
