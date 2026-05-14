/**
 * @flowdot-llc/guardian-agent quickstart example.
 *
 * Runs a tiny synthetic "trading agent" against a fake brokerage tool, with
 * all four supervisor primitives engaged: audit log, policy enforcement,
 * HITL gate, and emergency-stop.
 *
 * This file is illustrative — the reference implementation is pre-alpha and
 * the runtime classes used below are stubs in v0.1.0.  The example shows
 * the intended public API; SPEC.md (in the Python repo) is the canonical
 * contract.
 *
 * Run (once v0.1.0 lands):
 *   npm install
 *   npx tsx examples/quickstart.ts
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  GuardianRuntime,
  GuardianHaltedError,
  Policy,
  cliApprovalGate,
} from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICY_PATH = join(HERE, 'permissions.yaml');
const AUDIT_LOG = join(HERE, 'audit.jsonl');

async function main(): Promise<void> {
  const runtime = new GuardianRuntime({
    agentId: 'agent_demo',
    sessionId: 'sess_quickstart',
    auditLog: AUDIT_LOG,
    policy: await Policy.fromYaml(POLICY_PATH),
    approvalGate: cliApprovalGate,
  });

  // Tools wrapped with runtime.tool() are intercepted: every call is policy-
  // checked, optionally gated, recorded to the audit log, and bounded by the
  // emergency-stop primitive.

  const listBrokerageAccounts = runtime.tool(
    async (broker: string) => {
      return [
        { id: 'acct_001', broker, balanceUsd: 12_345.67 },
        { id: 'acct_002', broker, balanceUsd: 89_012.34 },
      ];
    },
    { name: 'list_brokerage_accounts' },
  );

  const getPositions = runtime.tool(
    async (_accountId: string) => {
      return [
        { symbol: 'VTI', shares: 42, marketValueUsd: 11_000.0 },
        { symbol: 'AAPL', shares: 10, marketValueUsd: 2_345.67 },
      ];
    },
    { name: 'get_positions' },
  );

  const placeOrder = runtime.tool(
    async (_accountId: string, _symbol: string, _side: string, _qty: number) => {
      // Policy denies this in permissions.yaml.
      return { status: 'filled', fillPriceUsd: 195.42 };
    },
    { name: 'place_order' },
  );

  console.log('@flowdot-llc/guardian-agent quickstart');
  console.log(`  audit log: ${AUDIT_LOG}`);
  console.log(`  policy:    ${POLICY_PATH}`);
  console.log('');

  try {
    // Step 1 — allowed by policy (mode: allow). No gate prompt.
    const accounts = await listBrokerageAccounts('schwab');
    console.log(`accounts: ${JSON.stringify(accounts)}`);

    // Step 2 — gated by policy (mode: gate). CLI prompt appears here.
    const firstAccount = accounts[0];
    if (firstAccount === undefined) throw new Error('no account returned');
    const positions = await getPositions(firstAccount.id);
    console.log(`positions: ${JSON.stringify(positions)}`);

    // Step 3 — denied by policy (mode: deny).  Logged, not executed.
    await placeOrder(firstAccount.id, 'AAPL', 'buy', 1);
  } catch (err) {
    if (err instanceof GuardianHaltedError) {
      console.log(`halted: ${err.message}`);
    } else {
      throw err;
    }
  }

  console.log('');
  console.log(`audit events written to ${AUDIT_LOG}`);
  console.log(`verify with: npx guardian-verify ${AUDIT_LOG}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
