# @flowdot-llc/guardian-agent

> TypeScript reference implementation of the [guardian-agent spec](https://github.com/flowdot-llc/guardian-agent/blob/main/SPEC.md). A runtime supervisor for tool-using LLM agents: tamper-evident audit log, tool-permission policy, HITL approval gates, emergency-stop, plus a runtime-safety layer (honeytokens, capability tripwires, per-class rate limits, two-key operator gates, heartbeat) and offline analysis tools.

**Status**: pre-alpha · tracks SPEC v0.5 · v0.10 feature milestone hit · interface stabilizing · not yet on npm

> Note on versioning: milestone labels in this README (v0.1, v0.2, …, v0.10) refer to **feature milestones** in the [ROADMAP](./ROADMAP.md), not semver. The package's npm semver lives in `package.json` and will track stable releases once the API freezes for npm publication.

The Python reference implementation lives at [`flowdot-llc/guardian-agent`](https://github.com/flowdot-llc/guardian-agent). This repository is the parallel TypeScript implementation. Both conform to the same versioned [spec](https://github.com/flowdot-llc/guardian-agent/blob/main/SPEC.md); the spec is the canonical contract, not either implementation.

---

## Why a second language

Python serves the research and evaluation ecosystem (LangChain, AutoGen, MCP Python clients, eval labs). TypeScript serves the production-runtime ecosystem — Node servers, Electron apps, TypeScript MCP clients, LangChain.js, and the broader JS agent tooling. The same spec, in both places, is how a single supervisory contract reaches both worlds.

Cross-language interop is real and intended:

- An audit log written by the Python implementation can be read and verified by the TypeScript implementation, and vice versa.
- A `permissions.yaml` is honored identically by both.
- A gate callback URL hosted by one can be invoked by the other.
- An `estop` triggered in one produces an audit event identical in structure to one triggered in the other.

## What's included

The library bundles three concentric layers. Each is independently usable; together they form the canonical supervisor.

**Trust foundation** (v0.1 – v0.7):

1. **Audit log** — hash-chained JSONL, optionally ed25519-signed. Every tool call gets a structured record. `guardian-verify` CLI confirms chain + signature integrity.
2. **Tool-permission policy** — HMAC-signed YAML policy with `once`/`session`/`forever`/`banned` scopes and glob-matched tool names. Model-aware `when` clauses (`model.provider`, `model.id`, `attribution_path`).
3. **HITL approval gate** — four reference adapters: CLI prompt, async webhook, programmatic callback, LiveKit data channel. Custom `GateOptionSet` lets consumers define their own button sets.
4. **Emergency stop** — `EStopLocal` for single-process deployments, `EStopHub` middleware + poller for hub-coordinated deployments (HTTP 423 Locked).

**Runtime safety layer** (v0.8 – v0.9):

5. **External chain attestation** ([SPEC §11](https://github.com/flowdot-llc/guardian-agent/blob/main/SPEC.md#11-external-chain-attestation-v030)) — periodically publish chain heads to an external append-only store. Closes the "compromised runtime forges its own log" gap. Reference adapters: `httpAttestor`, `nullAttestor`. Fail-soft on attestor outage.
6. **Honeytokens** ([SPEC §12](https://github.com/flowdot-llc/guardian-agent/blob/main/SPEC.md#12-honeytokens-v030)) — consumer-supplied value patterns + phantom tool names. Zero false positives by construction. Library ships **no default tokens**.
7. **Capability tags + Yellow-line tripwires** ([SPEC §13](https://github.com/flowdot-llc/guardian-agent/blob/main/SPEC.md#13-capability-tagging--tripwires-v030)) — tag tools with classes (`credential`, `network-egress`, `write`, ...) and define combination rules. v0.x ships Yellow-only (audit-row, no behavior change); Red-line auto-stop ships after real-surface telemetry calibrates thresholds.
8. **Per-capability rate limits** ([SPEC §14](https://github.com/flowdot-llc/guardian-agent/blob/main/SPEC.md#14-per-capability-rate-limits-v030)) — `MultiRateLimiter` with conservative defaults (credential=2/s, delete=1/s, network-egress=5/s).
9. **Two-key operator authorization** ([SPEC §15](https://github.com/flowdot-llc/guardian-agent/blob/main/SPEC.md#15-two-key-operator-authorization-v040)) — suspend dispatch pending fresh operator confirmation. Library defines the suspend/resume contract; consumers wire the transport.
10. **Dead-man's heartbeat** ([SPEC §16](https://github.com/flowdot-llc/guardian-agent/blob/main/SPEC.md#16-dead-mans-heartbeat-v040)) — soft warn + hard E-stop on missed liveness signals. Opt-in (default OFF).

**Offline analysis tools** (v0.10):

11. **`guardian-baseline`** ([SPEC §17](https://github.com/flowdot-llc/guardian-agent/blob/main/SPEC.md#17-behavioral-baselines-offline-v050)) — descriptive statistics on audit streams. `--check` flags σ-deviations. **Reports only; not a runtime tripwire.**
12. **`guardian-correlator`** ([SPEC §18](https://github.com/flowdot-llc/guardian-agent/blob/main/SPEC.md#18-cross-surface-correlation-offline-v050)) — overlapping sessions + args-hash collisions + sequence-similarity matches across multiple audit logs for the same agent_id.

---

## Quickstart

```typescript
import {
  AuditLogWriter,
  EStopLocal,
  GuardianRuntime,
} from '@flowdot-llc/guardian-agent';

const audit = new AuditLogWriter({
  path: './audit.jsonl',
  agentId: 'agent_demo',
  sessionId: 'sess_quickstart',
});
const estop = new EStopLocal({ audit });
const runtime = new GuardianRuntime({
  agentId: 'agent_demo',
  sessionId: 'sess_quickstart',
  audit,
  estop,
});

// Wrap any tool function — MCP, LangChain.js, native async fn:
const listAccounts = runtime.tool(
  async (broker: string) => [
    { id: 'acct_001', broker, balanceUsd: 12_345.67 },
  ],
  { name: 'list_accounts', capabilities: ['read'] },
);

// Your agent code calls these as normal. The runtime intercepts every call,
// records tool_call → policy_check → tool_result in the audit log.
const accounts = await listAccounts('schwab');

// Hit the kill switch from anywhere — another async context, a signal, an
// HTTP endpoint:
await estop.press({ reason: 'operator manual halt', initiator: 'operator' });

// Clean shutdown — flushes audit, attestation if configured:
await runtime.close();
```

### Adding the v0.8 safety layer

```typescript
import {
  AuditLogWriter,
  EStopLocal,
  GuardianRuntime,
  httpAttestor,
  defineHoneytokenSet,
} from '@flowdot-llc/guardian-agent';

const audit = new AuditLogWriter({
  path: './audit.jsonl',
  agentId: 'agent_demo',
  sessionId: 'sess_quickstart',
  // v0.8: external attestation
  attestor: httpAttestor({ url: 'https://attestor.example/v1/heads' }),
  attestEvery: 100,
});
const estop = new EStopLocal({ audit });
const runtime = new GuardianRuntime({
  agentId: 'agent_demo',
  sessionId: 'sess_quickstart',
  audit,
  estop,
  // v0.8: honeytokens
  honeytokens: defineHoneytokenSet('production', [
    { id: 'fake-aws', pattern: /AKIA[0-9A-Z]{16}/ },
    { id: 'recovery-key', value: 'fd_recovery_canary_REPLACE_ME' },
  ], ['delete_account_unsafe']),
  // v0.8: capability rules (Yellow-only)
  capabilityRules: [
    {
      id: 'exfil-shape',
      combination: ['credential', 'network-egress', 'write'],
      window_ms: 60_000,
      level: 'yellow',
    },
  ],
});
```

### v0.9: operator confirmation + heartbeat

```typescript
import {
  GuardianRuntime,
  callbackOperatorGate,
  HeartbeatMonitor,
} from '@flowdot-llc/guardian-agent';

const runtime = new GuardianRuntime({
  agentId: 'agent_demo',
  sessionId: 'sess_quickstart',
  audit,
  estop,
  operatorGate: callbackOperatorGate(async (req) => {
    // Show req to a real human (UI modal, IPC, webhook) and return their decision.
    const approved = await operatorUI.prompt(req);
    return { decision: approved ? 'approved' : 'denied', operator_id: 'alice' };
  }),
  operatorTimeoutMs: 5 * 60_000,
});

const sensitiveTool = runtime.tool(
  async () => doDangerousThing(),
  {
    name: 'wire_transfer',
    capabilities: ['network-egress', 'credential'],
    requiresOperatorConfirmation: true,
    operatorConfirmationReason: 'sensitive_action',
  },
);

// Heartbeat — opt-in. Surface MUST call heartbeat() from its main loop.
const heartbeat = new HeartbeatMonitor({
  softMs: 30_000,
  hardMs: 90_000,
  audit,
  estop,
});
heartbeat.start();
setInterval(() => heartbeat.heartbeat(), 10_000);
```

### Offline analysis

```bash
# Produce a per-agent_id statistical baseline
node dist/cli/guardian-baseline.js ~/.flowdot/audit/cli.jsonl

# Check a new session against the saved baseline
node dist/cli/guardian-baseline.js ~/.flowdot/audit/cli.jsonl --check --sigma 3

# Cross-surface correlation
node dist/cli/guardian-correlator.js \
  ~/.flowdot/audit/cli.jsonl:cli \
  ~/.flowdot/audit/mcp.jsonl:mcp \
  --out ~/.flowdot/audit/correlations.jsonl
```

See [`examples/quickstart.ts`](./examples/quickstart.ts) for a runnable version.

## What it is NOT

It is deliberately small. Not an agent harness. Not a platform. Not a workflow builder. Not an observability dashboard. Not a model evaluation suite. It is the supervisor primitive only.

Some things the library deliberately does NOT do:

- **Ship default honeytokens.** Library shipping plausible-looking fake credentials gets picked up by secret scanners + creates support load. Consumers register their own.
- **Promote Red-line capability rules without telemetry.** Yellow-only until real-surface data shows zero organic fires.
- **Use baselines as runtime tripwires.** Statistical anomaly detection is descriptive output, not a gate. Operator decides what to do.
- **Reason about agent intent.** Every primitive is a deterministic predicate over inputs.

## Relationship to FlowDot

FlowDot's commercial platform — hub, CLI, native Electron app, mobile, MCP server — uses this library directly. FlowDot's `flowdot-cli` and `mcp-server` supervisors are thin per-surface glue around the library's `GuardianRuntime` + `AuditLogWriter` + `EStopLocal`. The runtime-safety layer (attestation / honeytokens / capability tripwires / two-key / heartbeat) is wired through both surfaces.

The library itself is independent. Other Node-shaped agent projects can adopt the same supervisor primitives without depending on FlowDot's commercial stack.

## Project status & roadmap

Pre-alpha. Releases track the Python implementation milestone-for-milestone:

- **v0.1 – v0.7** ✅ Audit log + signatures + policy + gates + estop + model-aware policy.
- **v0.8** ✅ External attestation, honeytokens, capability tags + Yellow-line, per-capability rate limits.
- **v0.9** ✅ Two-key operator auth, dead-man's heartbeat.
- **v0.10** ✅ Offline `guardian-baseline` + `guardian-correlator` tools.
- **v0.11+** — Red-line capability auto-stop (after Yellow telemetry calibration). Python port. Cross-language conformance corpus.
- **v1.0** — Stable API, conformance suite in both languages, at least one production deployment outside FlowDot, published red-team study.

Full plan: [ROADMAP.md](./ROADMAP.md). Canonical spec: [SPEC.md](https://github.com/flowdot-llc/guardian-agent/blob/main/SPEC.md).

## Verification + testing posture

- **539 tests passing, 100% line + branch + function coverage** on the library.
- **Negative-corpus harness** replays real production audit logs (`~/.flowdot/audit/{cli,mcp}.jsonl`) through every safety detector at default thresholds; required outcome is zero false positives, and the bar is met.
- **No false E-stops, ever** is a hard rule. Any mechanism that could E-stop a session ships with thresholds calibrated against real-workload data.

## License

AGPL-3.0-or-later. See [LICENSE](./LICENSE). Commercial license: `licensing@flowdot.ai`.

## Citation

```
Mousseau, E. (2026). @flowdot-llc/guardian-agent: TypeScript reference
implementation of the guardian-agent spec. v0.10.
https://github.com/flowdot-llc/guardian-agent-ts
```
