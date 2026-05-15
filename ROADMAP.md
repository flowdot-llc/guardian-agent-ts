# @flowdot.ai/guardian-agent — roadmap

**Last updated**: 2026-05-14

This package tracks the Python reference implementation milestone-for-milestone. The spec at [`flowdot-llc/guardian-agent/SPEC.md`](https://github.com/flowdot-llc/guardian-agent/blob/main/SPEC.md) is the canonical contract for both.

## v0.1.0 — Package skeleton and audit log ✅

- [x] Package scaffolding: `package.json`, `tsconfig.json`, AGPL-3.0 license, README.
- [x] Public type surface matching the spec (`GuardianRuntime`, `Policy`, `GateRequest`, `GateResponse`, `ModelAttribution`).
- [x] JSONL audit log writer with hash chain.
- [x] `runtime.tool(fn, opts)` wrapper that records `tool_call` + `tool_result` events.
- [x] Quickstart example.
- [x] `vitest` suite exercising every record kind defined in spec §2.4.

## v0.2.0 — Tool-permission scoping ✅

- [x] YAML policy loader matching spec §3.
- [x] Wildcard tool-name matching with specificity rules.
- [x] `policy_check` event emission.
- [x] Resolution order (banned > forever > session > once > default).

## v0.3.0 — HITL approval gate ✅

- [x] `cliApprovalGate` — synchronous-feeling stdin prompt.
- [x] `asyncCallbackGate(url)` — POSTs `GateRequest`, awaits JSON response.
- [x] `programmaticGate(handler)` — async handler.
- [x] `dataChannelGate` — LiveKit-shaped wire frames.
- [x] `allow_session` / `always_allow` semantics with policy file persistence.

## v0.4.0 — Emergency-stop ✅

- [x] `EStopLocal` API + audit emission.
- [x] `EStopHub` adapter + middleware (HTTP 423 Locked).
- [x] `EStopPoller` pull-based safety net.
- [x] `AbortController`-style cross-async halt via `EStopLocal.abortSignal`.
- [x] `GuardianHaltedError` class; audit log flush on halt.

## v0.5.0 — Signed audit logs ✅

- [x] ed25519 via Node's `crypto`.
- [x] `guardian-verify` CLI for chain + signature integrity.
- [x] Recovery hook on abnormal-shutdown re-open (`onTipRecovered` + `x_session_recovered`).

## v0.6.0 — Model-aware policy ✅

- [x] `PolicyWhen.model.provider` + `model.id` glob clauses (SPEC §3 open question resolved).
- [x] `ModelAttribution` carried through the audit pipeline.

## v0.7.0 — Attribution-path policy + custom gate options ✅

- [x] `ModelAttribution` extended with `surface` + `aggregator` for the canonical chain `surface/aggregator/provider/id`.
- [x] `PolicyWhen.attribution_path` — flat-glob matcher (`*` matches `/`).
- [x] Custom `GateOptionSet` system (FLOWDOT_FIVE + CLASSIC_FOUR defaults + `defineGateOptionSet()`).

## v0.8.0 — Runtime safety foundation ✅

- [x] **External chain attestation** (SPEC §11) — `Attestor` interface, `httpAttestor` + `nullAttestor` reference adapters, fail-soft `x_chain_attested` / `x_chain_attestation_failed`.
- [x] **Honeytokens** (SPEC §12) — value + phantom-tool matchers; zero-default-tokens by design.
- [x] **Capability tags + Yellow-line tripwires** (SPEC §13) — canonical capability classes, `CapabilityWindow` sliding-window evaluator, audit-only Yellow events.
- [x] **Per-capability rate limits** (SPEC §14) — `MultiRateLimiter` with `DEFAULT_BUCKETS` (credential=2/s, delete=1/s, etc.).

## v0.9.0 — Operator gates ✅

- [x] **Two-key operator authorization** (SPEC §15) — `OperatorConfirmationGate` interface, `callbackOperatorGate` + `denyAllOperatorGate` reference adapters, `gate_id` correlation across pending/approved/denied rows, timeout-as-denied.
- [x] **Dead-man's heartbeat** (SPEC §16) — `HeartbeatMonitor` with soft + hard windows, opt-in (default OFF), `x_heartbeat_warning` + `estop_press { reason: 'heartbeat_missed' }`.

## v0.10.0 — Offline analysis tools ✅

- [x] **`guardian-baseline` CLI** (SPEC §17) — per-agent_id statistical profile + `--check` σ-deviation reports. Not a runtime tripwire.
- [x] **`guardian-correlator` CLI** (SPEC §18) — overlapping sessions + args-hash collisions + sequence similarity, writes `x_cross_surface_match` JSONL to its own log.

## v0.11+ — Red-line + Python port (next)

- [ ] **Red-line capability rules** (SPEC §13.3) — promotion path from Yellow → Red after demonstrated zero organic fires in real-surface telemetry. Auto-presses EStop on fire.
- [ ] **Python port** — faithful translation of every primitive to `guardian-agent` (Python). Same SPEC, same JSON corpus.
- [ ] **Cross-language conformance corpus** — shared test fixtures both implementations must round-trip.
- [ ] **Soak harness** — long-running real-workload replay producing the Yellow telemetry the Red-line promotion needs.

## v1.0.0 — Stable

Same exit criteria as Python v1.0.0:
- [ ] No breaking spec changes for 90 days.
- [ ] Conformance test suite passes in both languages.
- [ ] At least one production deployment outside FlowDot.
- [ ] Published red-team study citing this implementation.

## Non-goals through v1.0

- A web UI.
- An HTTP server. The library exposes types and adapter callables; you bring your HTTP layer.
- Bun/Deno-specific optimizations. Targeting Node 20+ LTS first.
- Becoming an agent framework. Composes with LangChain.js, MCP clients, AutoGen-TS, native async fns.
- Default honeytokens. Library never ships plausible-looking decoys; consumers register their own.
- A baseline-as-runtime-tripwire. Statistical profiles are descriptive reports, not gates.

## Sync with Python implementation

The two repos release in lockstep when possible. If one ships a feature ahead of the other:

- **Spec changes ship in the [Python repo](https://github.com/flowdot-llc/guardian-agent) first**, because that's where SPEC.md lives. The TS repo follows.
- **Bug fixes can ship independently.**
- **Conformance test fixtures are shared.** Both implementations run the same JSON test corpus from the spec repo.

## Test counts (current)

- guardian-agent-ts: **535/535** at **100% line + branch + function coverage**.
- FlowDot surface integrations: mcp-server **153/153**, flowdot-cli **666/666**.
- Negative-corpus harness (real `~/.flowdot/audit/{cli,mcp}.jsonl` replay) — zero false positives on every v0.8-v0.10 detector at default thresholds.
