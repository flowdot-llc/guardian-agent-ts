/**
 * Demo 2 — HITL approval gate intercepts a dangerous tool call.
 *
 * What this shows: tools tagged `requiresOperatorConfirmation: true` pause
 * before dispatch and ask a configured `operatorGate` for a decision.
 * Denial is recorded in the audit log with the same chain integrity as
 * any other tool result.
 *
 * Run: npx tsx examples/demo/demo-2-gate.ts
 *
 * The script:
 *   1. Wires a `callbackOperatorGate` that we control programmatically —
 *      simulates an operator hitting the deny button.
 *   2. Agent calls a safe `read_balance` tool — no gate, executes.
 *   3. Agent calls `wire_transfer` — gate fires, operator denies, tool
 *      is NOT executed (side effect counter stays at 0).
 *   4. Prints the audit row sequence: pending_operator → denied → halt.
 *
 * Audit log lands at examples/demo/audit-demo-2.jsonl (overwritten each run).
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { unlink } from 'node:fs/promises';

import {
  AuditLogWriter,
  AuditLogReader,
  GuardianRuntime,
  GuardianHaltedError,
  callbackOperatorGate,
} from '../../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const AUDIT_PATH = join(HERE, 'audit-demo-2.jsonl');

async function main(): Promise<void> {
  await unlink(AUDIT_PATH).catch(() => undefined);

  console.log('────────────────────────────────────────────────────────');
  console.log(' Demo 2 — HITL approval gate');
  console.log('────────────────────────────────────────────────────────');
  console.log('');

  const audit = new AuditLogWriter({
    path: AUDIT_PATH,
    agentId: 'demo-2-agent',
    sessionId: 'sess_demo_2',
  });

  // Simulated operator: in real life this would surface to a UI / IPC modal /
  // chat message / push notification. Here it just denies the wire_transfer.
  const operatorGate = callbackOperatorGate(async (req) => {
    console.log('  [operator gate] received request:');
    console.log(`    tool: ${req.tool_name}`);
    console.log(`    args: ${JSON.stringify(req.tool_args)}`);
    console.log(`    reason: ${req.reason}`);
    console.log('  [operator gate] → DENY');
    return { decision: 'denied', operator_id: 'alice@flowdot.ai', reason: 'amount exceeds review threshold' };
  });

  const runtime = new GuardianRuntime({
    agentId: 'demo-2-agent',
    sessionId: 'sess_demo_2',
    audit,
    operatorGate,
  });

  // Track real side effects so we can prove the denied tool didn't actually run.
  let wireTransferSideEffectCount = 0;

  const readBalance = runtime.tool(
    async (accountId: string) => ({ accountId, balanceUsd: 12_345.67 }),
    { name: 'read_balance', capabilities: ['read'] },
  );

  const wireTransfer = runtime.tool(
    async (toAccount: string, amount: number) => {
      // This side-effect MUST NOT run if the gate denied the call.
      wireTransferSideEffectCount += 1;
      return { toAccount, amount, status: 'completed' };
    },
    {
      name: 'wire_transfer',
      capabilities: ['credential', 'network-egress', 'write'],
      requiresOperatorConfirmation: true,
      operatorConfirmationReason: 'high-value money movement',
    },
  );

  console.log('Step 1: agent calls read_balance — no gate (capability: read)');
  const balance = await readBalance('acct_001');
  console.log(`  ✔ balance: ${JSON.stringify(balance)}`);
  console.log('');

  console.log('Step 2: agent calls wire_transfer — gate fires');
  try {
    await wireTransfer('acct_attacker', 50_000);
    console.log('  ✗ wire_transfer did NOT halt — demo is broken');
    process.exit(2);
  } catch (err) {
    if (err instanceof GuardianHaltedError) {
      console.log(`  ✓ halted: ${err.message}`);
    } else {
      throw err;
    }
  }
  console.log('');

  console.log('Step 3: prove the dangerous side effect did not fire');
  console.log(`  wire_transfer side-effect counter: ${wireTransferSideEffectCount}`);
  if (wireTransferSideEffectCount !== 0) {
    console.log('  ✗ side effect fired despite denial — demo is broken');
    process.exit(2);
  }
  console.log('  ✔ tool body did not execute');
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
    console.log(`  ${i}. kind=${rec.kind.padEnd(20)} status=${String(rec.status).padEnd(18)} tool=${toolName}`);
  }
  await reader.close();
  console.log('');
  console.log('Result: dangerous tool was intercepted before dispatch.');
  console.log('────────────────────────────────────────────────────────');

  // Hold the final frame for video capture.
  await new Promise((resolve) => setTimeout(resolve, 5000));
}

main().catch((err) => {
  console.error('demo-2 error:', err);
  process.exit(1);
});
