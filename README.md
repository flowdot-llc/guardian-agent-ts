# @flowdot-llc/guardian-agent

> TypeScript reference implementation of the [guardian-agent spec](https://github.com/flowdot-llc/guardian-agent/blob/main/SPEC.md). Audit log, tool-permission scoping, human-in-the-loop approval gates, and an emergency-stop primitive — as a small, dependency-light library that wraps any Node-shaped agent's tool-call loop.

**Status**: pre-alpha · spec v0.1.0 · interface unstable · not yet on npm

The Python reference implementation lives at [`flowdot-llc/guardian-agent`](https://github.com/flowdot-llc/guardian-agent). This repository is the parallel TypeScript implementation. Both conform to the same versioned [spec](https://github.com/flowdot-llc/guardian-agent/blob/main/SPEC.md); the spec is the canonical contract, not either implementation.

---

## Why a second language

Python serves the research and evaluation ecosystem (LangChain, AutoGen, MCP Python clients, eval labs). TypeScript serves the production-runtime ecosystem — Node servers, Electron apps, TypeScript MCP clients, LangChain.js, and the broader JS agent tooling. The same spec, in both places, is how a single supervisory contract reaches both worlds.

Cross-language interop is real and intended:

- An audit log written by the Python implementation can be read and verified by the TypeScript implementation, and vice versa.
- A `permissions.yaml` is honored identically by both.
- A gate callback URL hosted by one can be invoked by the other.
- An `estop` triggered in one produces an audit event identical in structure to one triggered in the other.

## The four primitives

The same four primitives as the Python implementation. See [SPEC.md](https://github.com/flowdot-llc/guardian-agent/blob/main/SPEC.md) for the canonical definitions:

1. **Audit log** — every tool call gets a structured, append-only JSONL record. Hash-chained for tamper evidence; optionally signed with ed25519 (v0.5+).
2. **Tool-permission scoping** — a YAML policy declares which tools are allowed, denied, session-only, or always-allow. Wildcards supported.
3. **HITL approval gate** — a configurable hook pauses the agent before a tool fires and surfaces an approval prompt to a human operator.
4. **Emergency-stop** — a process-wide kill switch. Triggered by signal, API call, or external callback.

## Quickstart

```typescript
import {
  GuardianRuntime,
  Policy,
  cliApprovalGate,
} from '@flowdot-llc/guardian-agent';

const runtime = new GuardianRuntime({
  agentId: 'agent_demo',
  sessionId: 'sess_quickstart',
  auditLog: './audit.jsonl',
  policy: await Policy.fromYaml('./permissions.yaml'),
  approvalGate: cliApprovalGate,
});

// Wrap any tool function — MCP, LangChain.js, native async fn:
const listBrokerageAccounts = runtime.tool(
  async (broker: string) => {
    return [
      { id: 'acct_001', broker, balanceUsd: 12_345.67 },
      { id: 'acct_002', broker, balanceUsd: 89_012.34 },
    ];
  },
  { name: 'list_brokerage_accounts' }
);

const getPositions = runtime.tool(
  async (accountId: string) => {
    return [
      { symbol: 'VTI', shares: 42, marketValueUsd: 11_000.0 },
      { symbol: 'AAPL', shares: 10, marketValueUsd: 2_345.67 },
    ];
  },
  { name: 'get_positions' }
);

// Your agent code calls these as normal. The runtime intercepts every call,
// checks the policy, optionally requests approval, runs the tool, writes
// the audit event. From inside the agent loop, nothing changes.

const accounts = await listBrokerageAccounts('schwab');
const positions = await getPositions(accounts[0].id);

// Hit the kill switch from anywhere — another async context, a signal, an
// HTTP endpoint:
runtime.estop({ reason: 'operator manual halt', operatorId: 'elliot@flowdot.ai' });
```

See [`examples/quickstart.ts`](./examples/quickstart.ts) for a runnable version.

## What it is NOT

The same negations as the Python implementation. It is deliberately small. It is not an agent harness, not a platform, not a workflow builder, not an observability dashboard, not a model evaluation suite. It is the supervisor primitive only.

## Relationship to FlowDot

FlowDot's commercial platform — hub, CLI, native Electron app, mobile, MCP server — runs an **independent** TypeScript runtime that also conforms to the [guardian-agent spec](https://github.com/flowdot-llc/guardian-agent/blob/main/SPEC.md). That code predates this repository and is a separate codebase. This package is intended for **other** Node-shaped agent projects that want the same supervisor primitives, off the shelf, without depending on FlowDot's commercial stack.

Over time, FlowDot's internal runtime may migrate to use this package directly. That is not the case today, and the goal of this package is independent: serve the broader Node ecosystem.

## Project status & roadmap

Pre-alpha. Releases track the Python implementation milestone-for-milestone:

- **v0.1.0** *(now)* — package skeleton + audit log writer + `runtime.tool(fn, opts)` wrapper.
- **v0.2.0** — Tool-permission scoping (policy YAML).
- **v0.3.0** — HITL approval gate adapters: CLI, async-callback, programmatic.
- **v0.4.0** — Emergency-stop primitive + `@guardian-agent/eval-js` companion (or use Python `guardian-eval` against TS-emitted audit logs — both work via shared format).
- **v0.5.0** — Hash-chained + ed25519-signed audit logs.
- **v1.0.0** — Stable API; first production deployment outside FlowDot.

Full plan: [ROADMAP.md](./ROADMAP.md).

## License

AGPL-3.0-or-later. See [LICENSE](./LICENSE). Commercial license: `licensing@flowdot.ai`.

## Citation

```
Mousseau, E. (2026). @flowdot-llc/guardian-agent: TypeScript reference
implementation of the guardian-agent spec. v0.1.0.
https://github.com/flowdot-llc/guardian-agent-ts
```
