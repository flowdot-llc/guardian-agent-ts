/**
 * Demo 1 — Tamper-evident audit log.
 *
 * What this shows: every tool call writes a hash-chained, ed25519-signed
 * record. Editing one record breaks the chain detectably.
 *
 * Run: npx tsx examples/demo/demo-1-tamper.ts
 *
 * The script:
 *   1. Generates a fresh ed25519 keypair (in memory; never written).
 *   2. Runs a small agent that makes 4 tool calls under supervision.
 *   3. Verifies the chain + signatures — passes.
 *   4. Tampers with one record by flipping a byte in its `detail` field.
 *   5. Verifies again — FAILS with a precise pointer to the broken record.
 *
 * Audit log lands at examples/demo/audit-demo-1.jsonl (overwritten each run).
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile, writeFile, unlink } from 'node:fs/promises';

import {
  AuditLogWriter,
  AuditLogReader,
  GuardianRuntime,
  generateEd25519KeyPair,
  GuardianIntegrityError,
} from '../../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const AUDIT_PATH = join(HERE, 'audit-demo-1.jsonl');

async function main(): Promise<void> {
  // Fresh log every run so the demo is reproducible.
  await unlink(AUDIT_PATH).catch(() => undefined);

  console.log('────────────────────────────────────────────────────────');
  console.log(' Demo 1 — Tamper-evident audit log');
  console.log('────────────────────────────────────────────────────────');
  console.log('');

  // 1. Generate an ed25519 keypair for signing this session's audit records.
  const { privateKey, publicKey } = generateEd25519KeyPair();

  const audit = new AuditLogWriter({
    path: AUDIT_PATH,
    agentId: 'demo-1-agent',
    sessionId: 'sess_demo_1',
    signWith: privateKey,
  });

  const runtime = new GuardianRuntime({
    agentId: 'demo-1-agent',
    sessionId: 'sess_demo_1',
    audit,
  });

  // 2. Small synthetic agent — four tool calls.
  const readFileTool = runtime.tool(
    async (path: string) => ({ path, bytes: 128 }),
    { name: 'read_file', capabilities: ['read'] },
  );
  const httpGet = runtime.tool(
    async (url: string) => ({ url, status: 200 }),
    { name: 'http_get', capabilities: ['network-egress'] },
  );
  const writeFileTool = runtime.tool(
    async (path: string, _bytes: number) => ({ path, ok: true }),
    { name: 'write_file', capabilities: ['write'] },
  );

  await readFileTool('/etc/hostname');
  await httpGet('https://example.com/api/status');
  await httpGet('https://example.com/api/profile');
  await writeFileTool('/tmp/report.txt', 256);

  await runtime.close();
  console.log(`✔ wrote audit log: ${AUDIT_PATH}`);
  console.log('');

  // 3. Verify — should pass.
  console.log('Step 1: verify the unaltered chain + signatures');
  let reader = await AuditLogReader.open(AUDIT_PATH);
  let chainCount = await reader.verifyChain();
  let sigCount = await reader.verifySignatures(publicKey);
  await reader.close();
  console.log(`  ✔ chain OK (${chainCount} records)`);
  console.log(`  ✔ signatures OK (${sigCount} records)`);
  console.log('');

  // 4. Tamper: flip the status of record #4 (a tool_call) from "approved"
  //    to "denied". Surgical change. Chain hash should immediately break.
  console.log('Step 2: tamper — change one record\'s status field');
  const raw = await readFile(AUDIT_PATH, 'utf8');
  const lines = raw.split('\n').filter((l) => l.length > 0);
  const target = JSON.parse(lines[3]!);
  console.log(`  target record kind=${target.kind} status=${target.status}`);
  target.status = 'denied'; // <- the tamper
  lines[3] = JSON.stringify(target);
  await writeFile(AUDIT_PATH, lines.join('\n') + '\n');
  console.log('  ✔ tamper applied');
  console.log('');

  // 5. Re-verify — should fail.
  console.log('Step 3: re-verify the tampered chain');
  reader = await AuditLogReader.open(AUDIT_PATH);
  try {
    await reader.verifyChain();
    console.log('  ✗ chain verification did NOT fail — demo is broken');
    process.exit(2);
  } catch (err) {
    if (err instanceof GuardianIntegrityError) {
      console.log(`  ✓ chain BROKEN — detected: ${err.message}`);
    } else {
      throw err;
    }
  } finally {
    await reader.close();
  }
  console.log('');
  console.log('Result: the supervisor detected the single-byte tamper.');
  console.log('────────────────────────────────────────────────────────');

  // Hold the final frame for video capture.
  await new Promise((resolve) => setTimeout(resolve, 5000));
}

main().catch((err) => {
  console.error('demo-1 error:', err);
  process.exit(1);
});
