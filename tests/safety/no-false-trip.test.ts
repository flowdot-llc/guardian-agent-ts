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
  CapabilityWindow,
  DEFAULT_BUCKETS,
  MultiRateLimiter,
  checkHoneytoken,
  defineHoneytokenSet,
  type CapabilityClass,
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

  // ==========================================================================
  // Capability-rule retroactive replay (v0.10 #1 calibration)
  // ==========================================================================
  //
  // The corpus pre-dates capability tagging — historical tool_call records
  // carry no `tool.capabilities` field. To validate the proposed Yellow
  // rule against real workflows we have to retro-tag.
  //
  // The retro-tagger duplicates a SIMPLIFIED form of the per-surface tagging
  // tables in `mcp-server/src/tool-capabilities.ts` and
  // `flowdot-cli/packages/core/src/services/tool-capabilities.ts`. Drift is
  // a real risk — refresh this when surface tables change.

  function retroTagMcp(toolName: string): CapabilityClass[] {
    const exact: Record<string, CapabilityClass[]> = {
      whoami: ['read', 'network-egress', 'credential'],
      agent_chat: ['execute', 'network-egress', 'credential'],
      panic_status: ['read'],
      panic_stop: ['execute', 'credential'],
      panic_clear: ['execute', 'credential'],
      email_send: ['write', 'network-egress', 'credential'],
      email_reply: ['write', 'network-egress', 'credential'],
      email_draft: ['write', 'network-egress', 'credential'],
      email_archive: ['write', 'network-egress', 'credential'],
      email_label: ['write', 'network-egress', 'credential'],
      email_delete: ['delete', 'network-egress', 'credential'],
      email_list_threads: ['read', 'network-egress', 'credential'],
      email_search: ['read', 'network-egress', 'credential'],
      email_read: ['read', 'network-egress', 'credential'],
      search: ['read', 'network-egress', 'credential'],
      send_notification: ['write', 'network-egress', 'credential'],
      query_knowledge_base: ['read', 'network-egress', 'credential'],
    };
    // Strip mcp__<server>__ prefix if present (toolkit doubling).
    let stripped = toolName;
    if (toolName.startsWith('mcp__')) {
      const parts = toolName.split('__');
      if (parts.length >= 3) stripped = parts.slice(2).join('__');
    }
    if (exact[toolName]) return exact[toolName] as CapabilityClass[];
    if (exact[stripped]) return exact[stripped] as CapabilityClass[];
    const writePrefixes = [
      'add_', 'create_', 'update_', 'insert_', 'append_', 'prepend_', 'patch_',
      'set_', 'toggle_', 'favorite_', 'vote_', 'link_', 'unlink_', 'move_',
      'transfer_', 'publish_', 'unpublish_', 'reprocess_', 'upload_', 'clone_',
      'duplicate_', 'fork_', 'copy_', 'complete_', 'abandon_', 'pause_',
      'resume_', 'retry_', 'share_', 'install_', 'checkpoint_', 'restore_',
      'rename_', 'edit_',
    ];
    const readPrefixes = ['list_', 'get_', 'search_', 'browse_', 'find_', 'query_', 'describe_', 'validate_'];
    const executePrefixes = ['execute_', 'cancel_', 'stream_', 'invoke_', 'emit_', 'test_', 'check_'];
    if (stripped.startsWith('delete_')) return ['delete', 'network-egress', 'credential'];
    if (stripped.startsWith('uninstall_')) return ['delete', 'network-egress', 'credential'];
    for (const p of writePrefixes) {
      if (stripped.startsWith(p)) return ['write', 'network-egress', 'credential'];
    }
    for (const p of readPrefixes) {
      if (stripped.startsWith(p)) return ['read', 'network-egress', 'credential'];
    }
    for (const p of executePrefixes) {
      if (stripped.startsWith(p)) return ['execute', 'network-egress', 'credential'];
    }
    return ['unknown'];
  }

  function retroTagCli(action: string): CapabilityClass[] {
    const builtin: Record<string, CapabilityClass[]> = {
      read: ['read'],
      search: ['read'],
      analyze: ['read'],
      'find-definition': ['read'],
      'edit-file': ['write'],
      'create-file': ['write'],
      'execute-command': ['execute', 'system-path'],
      'web-search': ['read', 'network-egress'],
      'fetch-url': ['read', 'network-egress'],
      'query-knowledge-base': ['read', 'network-egress', 'credential'],
      'list-knowledge-documents': ['read', 'network-egress', 'credential'],
      'get-knowledge-document': ['read', 'network-egress', 'credential'],
      'get-knowledge-document-content': ['read', 'network-egress', 'credential'],
      'update-knowledge-document-content': ['write', 'network-egress', 'credential'],
      'patch-knowledge-document-section': ['write', 'network-egress', 'credential'],
      'list-knowledge-categories': ['read', 'network-egress', 'credential'],
      'create-knowledge-category': ['write', 'network-egress', 'credential'],
      'upload-knowledge-text': ['write', 'network-egress', 'credential'],
      'get-knowledge-storage': ['read', 'network-egress', 'credential'],
      'send-notification': ['write', 'network-egress', 'credential'],
    };
    return builtin[action] ?? ['unknown'];
  }

  function retroTag(record: AuditRecord): CapabilityClass[] {
    const tool = record.tool?.name ?? '';
    if (!tool) return ['unknown'];
    if (record.agent_id === 'flowdot-cli') return retroTagCli(tool);
    return retroTagMcp(tool);
  }

  // The Yellow rule both surfaces ship in init.
  const EXFIL_SHAPE_RULE = {
    id: 'exfil-shape',
    combination: ['credential', 'network-egress', 'write'] as CapabilityClass[],
    window_ms: 60_000,
    level: 'yellow' as const,
  };

  for (const file of CORPUS_FILES) {
    it(`v0.10 capability replay: exfil-shape Yellow rule produces ZERO false fires on ${file}`, () => {
      const records = loadCorpus(file);
      const toolCalls = records.filter((r) => r.kind === 'tool_call' && r.tool);
      if (toolCalls.length === 0) {
        // No tool_calls in this fixture (CLI corpus is mostly session lifecycle).
        // Nothing to retro-tag; pass trivially.
        return;
      }
      const window = new CapabilityWindow({
        rules: [EXFIL_SHAPE_RULE],
        now: () => 0, // overwritten per-record below
      });
      // Inject the real ts as the window's clock by re-creating the matcher
      // with a closure-tracked counter, OR simpler: feed events in
      // chronological order with a `now()` that returns each record's ts.
      let clock = 0;
      const windowWithClock = new CapabilityWindow({
        rules: [EXFIL_SHAPE_RULE],
        now: () => clock,
      });
      const fires: { eventId: string; tool: string }[] = [];
      for (const r of toolCalls) {
        clock = new Date(r.ts).getTime();
        const caps = retroTag(r);
        const matches = windowWithClock.record(caps, r.event_id);
        for (const m of matches) {
          fires.push({ eventId: r.event_id, tool: r.tool!.name });
          void m;
        }
      }
      void window; // silence unused warning from the first constructor

      // If this assertion fails, either (a) the corpus genuinely contains
      // the exfil-shape pattern (and the operator should review), or
      // (b) the proposed Yellow rule is too broad and needs tightening
      // before deployment. Per plan: "no false E-stops, ever" applies to
      // Yellow data feeding Red promotion too.
      expect(fires).toEqual([]);
    });
  }
});
