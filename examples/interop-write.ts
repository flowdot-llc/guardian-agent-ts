/**
 * Cross-language interop demo. Writes an audit log via the TS impl.
 * The Python impl can then verify the same chain.
 */
import { join } from 'node:path';
import { AuditLogWriter } from '../src/audit/writer.js';

async function main() {
  const path = join(process.cwd(), 'examples/interop-audit.jsonl');
  const w = new AuditLogWriter({ path, agentId: 'agent_interop', sessionId: 'sess_demo' });
  await w.append({ kind: 'session_open', status: 'approved', initiator: 'system' });
  await w.append({
    kind: 'tool_call',
    status: 'pending',
    initiator: 'agent',
    tool: { name: 'list_accounts', args: { broker: 'schwab' } },
    model: { provider: 'anthropic', id: 'claude-opus-4.5' },
  });
  await w.append({
    kind: 'tool_result',
    status: 'executed',
    initiator: 'system',
    tool: {
      name: 'list_accounts',
      args: { broker: 'schwab' },
      result: [{ id: 'acct_001' }],
      duration_ms: 12,
    },
  });
  await w.append({ kind: 'session_close', status: 'approved', initiator: 'system' });
  await w.close();
  console.log(`wrote ${path}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
