# @flowdot-llc/guardian-agent — roadmap

**Last updated**: 2026-05-13

This package tracks the Python reference implementation milestone-for-milestone. The spec at [`flowdot-llc/guardian-agent/SPEC.md`](https://github.com/flowdot-llc/guardian-agent/blob/main/SPEC.md) is the canonical contract for both.

## v0.1.0 — Package skeleton and audit log (now)

- [x] Package scaffolding: `package.json`, `tsconfig.json`, AGPL-3.0 license, README.
- [x] Public type surface matching the spec (`GuardianRuntime`, `Policy`, `GateRequest`, `GateResponse`, `ModelAttribution`).
- [ ] JSONL audit log writer with hash chain.
- [ ] `runtime.tool(fn, opts)` wrapper that records `tool_call` + `tool_result` events.
- [ ] Quickstart example that runs end-to-end without policy enforcement (audit-only mode).
- [ ] `vitest` suite exercising every record kind defined in spec §2.4.
- [ ] Compatibility test: audit log written by this implementation MUST be readable and hash-chain-verifiable by the Python implementation.

**Exit criteria**: `npm install && npm run build` works; `npx tsx examples/quickstart.ts` produces a valid `audit.jsonl`; the file passes verification by the Python `guardian-verify` CLI.

## v0.2.0 — Tool-permission scoping

- [ ] YAML policy loader matching spec §3.
- [ ] Wildcard tool-name matching with specificity rules.
- [ ] `policy_check` event emission.
- [ ] Tests against the same fixture corpus the Python implementation uses (shared via the spec repo).
- [ ] CLI tool: `npx guardian-policy validate <file.yaml>`.

## v0.3.0 — HITL approval gate

- [ ] `cliApprovalGate` — synchronous-feeling stdin prompt (uses `readline`).
- [ ] `asyncCallbackGate(url)` — POSTs `GateRequest`, awaits JSON response.
- [ ] `programmaticGate(handler)` — async handler.
- [ ] `allow_session` / `always_allow` semantics with policy file persistence.
- [ ] Cross-language compatibility test: a Python gate adapter must be able to serve TypeScript runtime requests via async-callback.

## v0.4.0 — Emergency-stop + eval companion

- [ ] `runtime.estop()` API.
- [ ] `SIGUSR2` reserved for E-stop in Node (Node already uses `SIGUSR1` for the inspector).
- [ ] `AbortController`-style cross-async halt.
- [ ] `GuardianHaltedError` class; audit log flush on halt.
- [ ] `@guardian-agent/eval-js`: optional. The Python `guardian-eval` already works against TypeScript-produced audit logs via the shared JSONL format; a native JS eval companion is added only if there's adopter demand.

## v0.5.0 — Signed audit logs

- [ ] ed25519 via Node's built-in `crypto.subtle` (no native deps).
- [ ] Cross-language signature verification: a log signed by Python verifies under TS, and vice versa.

## v1.0.0 — Stable

Same exit criteria as Python v1.0.0:
- [ ] No breaking spec changes for 90 days.
- [ ] Conformance test suite passes.
- [ ] At least one production deployment outside FlowDot.
- [ ] Published red-team study citing this implementation.

## Non-goals through v1.0

- A web UI.
- An HTTP server. The library exposes types and adapter callables; you bring your HTTP layer.
- Bun/Deno-specific optimizations. Targeting Node 20+ LTS first.
- Becoming an agent framework. Composes with LangChain.js, MCP clients, AutoGen-TS, native async fns.

## Sync with Python implementation

The two repos release in lockstep when possible. If one ships a feature ahead of the other:

- **Spec changes ship in the [Python repo](https://github.com/flowdot-llc/guardian-agent) first**, because that's where SPEC.md lives. The TS repo follows.
- **Bug fixes can ship independently.**
- **Conformance test fixtures are shared.** Both implementations run the same JSON test corpus from the spec repo.
