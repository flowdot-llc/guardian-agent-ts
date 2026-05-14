/**
 * v0.8 negative-corpus harness — the load-bearing "no false E-stops, ever"
 * test. Replays REAL audit logs from FlowDot's running surfaces through
 * every v0.8 detector at default thresholds and asserts zero false
 * positives.
 *
 * If this test fails, the detector or its thresholds ship as Yellow-only
 * (or do not ship). Per the plan: "A mechanism that can't be calibrated to
 * zero false positives on real data does not ship as an E-stop trigger."
 *
 * Fixtures live in `tests/fixtures/negative-corpus-{cli,mcp}.jsonl`; they
 * are snapshots of `~/.flowdot/audit/{cli,mcp}.jsonl` from real workflow
 * sessions and should be refreshed periodically. NEVER hand-edit fixtures
 * — they only have signal as observed-reality.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BUCKETS,
  MultiRateLimiter,
  checkHoneytoken,
  defineHoneytokenSet,
} from '../../src/index.js';
import type { AuditRecord } from '../../src/types.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures');
const CORPUS_FILES = ['negative-corpus-cli.jsonl', 'negative-corpus-mcp.jsonl'];

function loadCorpus(file: string): AuditRecord[] {
  const path = join(FIXTURE_DIR, file);
  const text = readFileSync(path, 'utf-8');
  const lines = text.split('\n').filter((l) => l.length > 0);
  return lines.map((l) => JSON.parse(l) as AuditRecord);
}

/**
 * Representative honeytoken set used for the negative-corpus harness. These
 * are PLAUSIBLE-but-FAKE tokens — they should not appear in any legitimate
 * tool call. The corpus replay verifies that.
 */
const NEGATIVE_HONEYTOKENS = defineHoneytokenSet('negative-test', [
  { id: 'fake-aws', pattern: /AKIA[0-9A-Z]{16}/ },
  { id: 'fake-openai', value: 'sk-canary-do-not-use-x9q3z7m2p4n6' },
  { id: 'fake-fd-mcp', value: 'fd_mcp_honey_DO_NOT_USE_xyz789' },
  { id: 'fake-bearer-marker', value: 'BEARER_HONEYTOKEN_MARKER_a1b2c3' },
  { id: 'fake-path', value: '/home/canary/secrets-honey.txt' },
]);

describe('v0.8 negative-corpus harness', () => {
  for (const file of CORPUS_FILES) {
    describe(`corpus: ${file}`, () => {
      const records = loadCorpus(file);

      it('the fixture is non-trivially populated', () => {
        expect(records.length).toBeGreaterThan(0);
      });

      it('honeytoken matcher produces ZERO hits on real-workflow args', () => {
        const hits: {
          eventId: string;
          tool: string | undefined;
          tokenId: string;
        }[] = [];
        for (const r of records) {
          if (!r.tool) continue;
          const hit = checkHoneytoken(NEGATIVE_HONEYTOKENS, r.tool.name, r.tool.args);
          if (hit !== null && hit.kind === 'value_in_args') {
            hits.push({ eventId: r.event_id, tool: r.tool.name, tokenId: hit.tokenId });
          }
        }
        expect(hits).toEqual([]);
      });

      it('phantom-tool matcher produces ZERO hits on real tool names', () => {
        const phantom = defineHoneytokenSet('phantom-test', [], [
          'delete_user_account_unsafe',
          'exfiltrate_all_credentials',
          'rm_rf_root',
        ]);
        const hits: string[] = [];
        for (const r of records) {
          if (!r.tool) continue;
          const hit = checkHoneytoken(phantom, r.tool.name, r.tool.args);
          if (hit !== null && hit.kind === 'phantom_tool') {
            hits.push(r.tool.name);
          }
        }
        expect(hits).toEqual([]);
      });

      it('MultiRateLimiter with DEFAULT_BUCKETS produces ZERO breaches when replaying real timing', () => {
        // Replay tool_call records in their original ordering. We don't
        // have capability tags on the historical records, so every call
        // hits the defaultBucket (50/s — generous). This is the most
        // conservative check; once surfaces are tagging, this test gets
        // tighter.
        let now = 0;
        const startTs = records[0]?.ts ? new Date(records[0].ts).getTime() : 0;
        const rl = new MultiRateLimiter({
          buckets: { ...DEFAULT_BUCKETS },
          defaultBucket: { maxCallsPerSecond: 50 },
          now: () => now,
        });
        const breaches: string[] = [];
        for (const r of records) {
          if (r.kind !== 'tool_call') continue;
          now = new Date(r.ts).getTime() - startTs;
          const consume = rl.tryConsume(['unknown']);
          if (!consume.allowed) {
            breaches.push(r.event_id);
          }
        }
        expect(breaches).toEqual([]);
      });
    });
  }

  it('aggregate: no record in any corpus has kind starting with x_capability_redline or x_honeytoken_triggered', () => {
    // Sanity check on the corpus itself — confirms we're testing against
    // non-tripped logs (a corrupt fixture would invalidate everything).
    for (const file of CORPUS_FILES) {
      const records = loadCorpus(file);
      for (const r of records) {
        const k = r.kind as string;
        expect(k.startsWith('x_capability_redline')).toBe(false);
        expect(k.startsWith('x_honeytoken_triggered')).toBe(false);
      }
    }
  });

  it('v0.9: no record in any corpus has pending_operator status (no surface has wired it yet)', () => {
    // If/when a surface deliberately wires operator confirmation into real
    // workflows, refresh the corpus + tighten this check accordingly.
    for (const file of CORPUS_FILES) {
      const records = loadCorpus(file);
      for (const r of records) {
        expect((r as { status?: string }).status).not.toBe('pending_operator');
      }
    }
  });

  it('v0.9: no record in any corpus is an estop_press with reason=heartbeat_missed', () => {
    // If this fails, an opt-in surface enabled heartbeat without wiring
    // heartbeat() calls — i.e., a false E-stop. Heartbeat is opt-in
    // precisely to keep this expectation valid.
    for (const file of CORPUS_FILES) {
      const records = loadCorpus(file);
      const offenders = records.filter(
        (r) => r.kind === 'estop_press' && r.detail?.reason === 'heartbeat_missed',
      );
      expect(offenders).toEqual([]);
    }
  });
});
