# DESIGN — @flowdot.ai/guardian-agent (TypeScript)

Internal design doc. Locks the module structure and public API before Phase 3 implementation begins.

Last updated 2026-05-13. Status: APPROVED for v0.1 → v0.7 implementation.

---

## Public API surface (locked at v0.1.0)

Everything users `import` from the package. Stable across v0.1 → v0.7; additive changes only until v1.0.0.

```typescript
// runtime
export { GuardianRuntime } from './runtime/runtime.js';
export type { GuardianRuntimeOptions, ToolOptions } from './runtime/runtime.js';

// audit
export { AuditLogWriter, AuditLogReader, openAuditLog, readAuditLog } from './audit/index.js';
export type {
  AuditRecord,
  AuditRecordKind,
  AuditRecordStatus,
  AuditRecordInitiator,
} from './types.js';

// policy
export { PolicyStore, PolicyEvaluator, loadPolicy, loadPolicyFromYaml } from './policy/index.js';
export type {
  Policy,
  PolicyRule,
  PolicyScope,
  PolicyDecision,
  PolicyEvaluation,
} from './policy/types.js';

// gate
export {
  cliApprovalGate,
  asyncCallbackGate,
  programmaticGate,
  dataChannelGate,
} from './gate/index.js';
export type { ApprovalGate, GateRequest, GateResponse, GateGranularity } from './gate/types.js';

// estop
export { EStopLocal, EStopHub, createEStopMiddleware, createEStopPoller } from './estop/index.js';
export type {
  EStopState,
  EStopPressOptions,
  EStopClearOptions,
  EStopBroadcastChannel,
  EStopMiddlewareOptions,
  EStopPollerOptions,
} from './estop/types.js';

// notify
export { consoleNotifier, webhookNotifier, multiNotifier } from './notify/index.js';
export type { Notifier, NotificationEvent, NotificationKind } from './notify/types.js';

// shared
export type { ModelAttribution } from './types.js';
export { GuardianHaltedError, GuardianConfigError, GuardianIntegrityError } from './errors.js';

export const VERSION: string;       // e.g. '0.1.0' (matches package.json)
export const SPEC_VERSION: string;  // e.g. '0.2.0' (matches SPEC.md version this impl conforms to)
```

---

## File layout

```
src/
├── index.ts                       # The public exports above, nothing else.
├── types.ts                       # Shared types: ModelAttribution, AuditRecord, AuditRecord*.
├── errors.ts                      # GuardianHaltedError, GuardianConfigError, GuardianIntegrityError.
├── audit/
│   ├── index.ts                   # Re-exports.
│   ├── writer.ts                  # AuditLogWriter — single-writer queue, JSONL append, hash chain.
│   ├── reader.ts                  # AuditLogReader — iterate + verify hash chain (+ signatures v0.5+).
│   ├── chain.ts                   # computeRecordHash, verifyChain. Stateless helpers.
│   └── signature.ts               # v0.5+: ed25519 sign/verify.
├── policy/
│   ├── index.ts                   # Re-exports.
│   ├── types.ts                   # Policy, PolicyRule, PolicyScope, PolicyDecision, PolicyEvaluation.
│   ├── store.ts                   # PolicyStore — HMAC-signed read/write of permissions.yaml + session.yaml.
│   ├── evaluator.ts               # PolicyEvaluator — resolution order + wildcards + categories.
│   ├── loader.ts                  # loadPolicyFromYaml — parse + validate + structural checks.
│   ├── integrity.ts               # signPayload, verifyPayload (HMAC-SHA256 via Node crypto.subtle).
│   ├── site-key.ts                # SiteKey — read/create .flowdot/site.key.
│   ├── lock.ts                    # File-lock wrapper (proper-lockfile shim).
│   └── categories.ts              # Built-in category enum + CATEGORY_PREFIX.
├── gate/
│   ├── index.ts                   # Re-exports.
│   ├── types.ts                   # GateRequest, GateResponse, ApprovalGate, GateGranularity.
│   ├── cli.ts                     # cliApprovalGate — blocking readline prompt.
│   ├── async-callback.ts          # asyncCallbackGate(url) — fetch POST, await JSON response.
│   ├── programmatic.ts            # programmaticGate(handler) — wraps a callable.
│   └── data-channel.ts            # dataChannelGate — frame encode/decode for LiveKit-shape transports.
├── estop/
│   ├── index.ts                   # Re-exports.
│   ├── types.ts                   # EStopState, EStopPressOptions, EStopClearOptions, EStopBroadcastChannel.
│   ├── local.ts                   # EStopLocal — in-process flag with AbortController.
│   ├── hub.ts                     # EStopHub — hub-coordinated adapter with 1s cache TTL.
│   ├── middleware.ts              # createEStopMiddleware — Express/Connect/Fastify-compatible factory.
│   └── poller.ts                  # createEStopPoller — 5s pull-based safety net.
├── notify/
│   ├── index.ts                   # Re-exports.
│   ├── types.ts                   # Notifier, NotificationEvent, NotificationKind.
│   ├── console.ts                 # consoleNotifier — stderr.
│   ├── webhook.ts                 # webhookNotifier(url, opts) — POST JSON.
│   ├── email.ts                   # emailNotifier — opt-in via dynamic import of nodemailer.
│   └── multi.ts                   # multiNotifier — fan-out helper.
└── runtime/
    ├── index.ts                   # Re-exports.
    └── runtime.ts                 # GuardianRuntime — orchestrator. tool(), estop(), session().

tests/
├── audit/
├── policy/
├── gate/
├── estop/
├── notify/
├── runtime/
├── integration/                   # End-to-end runtime → audit → gate → estop flows.
├── conformance/                   # Cross-language fixtures (consumed from guardian-agent Python repo).
└── fixtures/                      # Local-only test fixtures.

examples/
├── quickstart.ts                  # Already exists; updated to use real API.
└── permissions.yaml               # Already exists; updated to v0.2 schema.

bin/
└── guardian-verify.ts             # CLI for log integrity verification. v0.5.0.

.github/workflows/
├── ci.yml                         # vitest, eslint, tsc; 100% coverage gate.
├── release.yml                    # npm publish on tag.
└── conformance.yml                # Run shared corpus from Python repo against this impl.
```

---

## Module responsibilities

### `runtime/runtime.ts` — GuardianRuntime

The single object users construct.

```typescript
class GuardianRuntime {
  constructor(options: GuardianRuntimeOptions);

  // Wrap a tool function. Returns a function with the same call signature.
  tool<Args extends unknown[], Result>(
    fn: (...args: Args) => Promise<Result> | Result,
    opts?: ToolOptions,
  ): (...args: Args) => Promise<Result>;

  // Trip the emergency-stop primitive locally.
  estop(options: EStopPressOptions): Promise<void>;

  // Idempotent shutdown: flush audit log, close handles.
  close(): Promise<void>;

  // Properties (read-only)
  readonly agentId: string;
  readonly sessionId: string;
  readonly auditLogPath: string;
}

interface GuardianRuntimeOptions {
  agentId: string;
  sessionId?: string;                       // auto-generated if absent
  auditLog: string | AuditLogWriter;        // path or pre-constructed writer
  policy: Policy | PolicyStore;             // loaded policy or live store
  approvalGate?: ApprovalGate;              // required if any rule resolves to `prompt`
  estop?: EStopLocal | EStopHub;            // default: new EStopLocal()
  notifier?: Notifier;                      // default: no-op
  defaultModel?: ModelAttribution;          // recorded on every tool_call if not supplied per-call
}

interface ToolOptions {
  name?: string;                            // defaults to fn.name
  granularity?: GateGranularity;            // default 'tool'
  model?: ModelAttribution;                 // override for this tool
}
```

Behavior of `runtime.tool(fn, opts)(args...)`:
1. Generate `event_id` (ULID).
2. Write `tool_call` audit record (`status: pending`).
3. Check `estop.isPressed()` — if true, write `policy_check (denied, reason: halt)` and throw `GuardianHaltedError`.
4. Evaluate policy. If `prompt`, invoke `approvalGate`. Write `gate_request` and `gate_response` records.
5. If decision allows (`allow` / `allow_session` / `allow_forever`), execute the tool. On success, write `tool_result` (`executed`); on throw, write `tool_result` (`errored`) and re-throw. Persist policy upgrades to PolicyStore.
6. If decision denies (`deny` / `ban_forever`), throw `Error('policy_denied: <tool>')`. Persist bans to PolicyStore.

### `audit/writer.ts` — AuditLogWriter

```typescript
class AuditLogWriter {
  constructor(options: AuditLogWriterOptions);

  // Append a record. Computes hash chain, writes JSONL line. Single-writer queue.
  append(record: Omit<AuditRecord, 'prev_hash' | 'event_id' | 'ts' | 'signature'>): Promise<AuditRecord>;

  // Flush pending writes and close the file handle.
  close(): Promise<void>;

  // Last-record hash (for hash-chain continuation across runtime restarts).
  readonly tipHash: string;
}

interface AuditLogWriterOptions {
  path: string;
  signWith?: Ed25519PrivateKey;       // v0.5+
  fileMode?: number;                  // default 0o600
}
```

Internal: a `p-queue` (concurrency 1) serializes appends so the hash chain is always strictly ordered. The writer reads the last line on open to recover `tipHash`.

### `audit/reader.ts` — AuditLogReader

```typescript
class AuditLogReader {
  static async open(path: string): Promise<AuditLogReader>;

  // Async iterator over all records.
  [Symbol.asyncIterator](): AsyncIterableIterator<AuditRecord>;

  // Verify the full hash chain. Throws GuardianIntegrityError on break.
  verifyChain(): Promise<void>;

  // Verify all signatures (v0.5+). Throws on first failure.
  verifySignatures(publicKey: Ed25519PublicKey): Promise<void>;
}
```

### `policy/store.ts` — PolicyStore

```typescript
class PolicyStore {
  static async open(options: PolicyStoreOptions): Promise<PolicyStore>;

  // Returns the merged view: persistent + session rules.
  getPolicy(): Policy;

  // Add a rule. Persists to permissions.yaml or session.yaml depending on scope.
  addRule(rule: PolicyRule): Promise<void>;

  // Remove a rule by exact tool name.
  removeRule(toolName: string, scope: PolicyScope): Promise<void>;

  // Clear all session rules. Called on session end.
  clearSession(): Promise<void>;

  // Idempotent close.
  close(): Promise<void>;
}

interface PolicyStoreOptions {
  dir: string;                  // e.g. '.flowdot' or '.guardian'
  agentId: string;
  siteKey?: SiteKey;            // auto-loaded if absent
}
```

Both `permissions.yaml` and `session.yaml` are read/written under an advisory file lock. HMAC-SHA256 over canonical YAML payload using the site key.

### `policy/evaluator.ts` — PolicyEvaluator

```typescript
class PolicyEvaluator {
  constructor(policy: Policy);

  // Evaluate a tool name (+ optional model attribution for model-aware rules in v0.6).
  evaluate(toolName: string, model?: ModelAttribution): PolicyEvaluation;
}

interface PolicyEvaluation {
  decision: 'allow' | 'deny' | 'prompt';
  matchedRule?: PolicyRule;
  matchedAt: 'exact' | 'wildcard' | 'category' | 'default';
  scope: PolicyScope;
}
```

Resolution implements SPEC §3.3 exactly. Banned-beats-allow at every layer.

### `estop/local.ts` — EStopLocal

```typescript
class EStopLocal {
  constructor(options?: { initiallyPressed?: boolean });

  isPressed(): boolean;

  press(options: EStopPressOptions): Promise<EStopPressResult>;

  // Clearing an in-process EStopLocal returns true; the runtime instance must
  // still be reconstructed to resume (sessions are terminal on halt).
  clear(options: EStopClearOptions): Promise<EStopClearResult>;

  // For host-process integration (signals, external aborts).
  readonly abortSignal: AbortSignal;
}
```

### `estop/hub.ts` — EStopHub

```typescript
class EStopHub {
  constructor(options: EStopHubOptions);

  isPressed(userId: string): Promise<boolean>;     // 1s cache TTL
  press(userId: string, options: EStopPressOptions): Promise<EStopPressResult>;
  clear(userId: string, options: EStopClearOptions): Promise<EStopClearResult>;
  status(userId: string): Promise<EStopState>;
  events(userId: string, opts?: { limit?: number }): Promise<AuditRecord[]>;
}

interface EStopHubOptions {
  state: EStopStateStore;                          // backed by DB or in-memory
  audit: AuditLogWriter;
  notifier?: Notifier;
  broadcast?: EStopBroadcastChannel;               // optional fan-out to daemons
  cacheTtlMs?: number;                             // default 1000
  recentAuthCheck?: (userId: string, options: EStopClearOptions) => Promise<boolean>;
}
```

### `estop/middleware.ts` — createEStopMiddleware

```typescript
function createEStopMiddleware(
  hub: EStopHub,
  options?: EStopMiddlewareOptions,
): RequestHandler;

interface EStopMiddlewareOptions {
  resolveUserId: (req: Request) => string | null;  // host supplies; library doesn't auth
  exclude?: (req: Request) => boolean;             // bypass for /estop/clear et al.
  lockedResponseBody?: (state: EStopState) => unknown;  // override 423 body
}
```

Returns 423 with structured JSON when the user is pressed. Compatible with Express/Connect/Fastify (the handler signature is the standard `(req, res, next)`).

### `estop/poller.ts` — createEStopPoller

```typescript
function createEStopPoller(options: EStopPollerOptions): EStopPoller;

interface EStopPollerOptions {
  statusUrl: string;                              // GET endpoint returning EStopState
  onPress: (state: EStopState) => void | Promise<void>;
  onClear: (state: EStopState) => void | Promise<void>;
  intervalMs?: number;                            // default 5000
  fetch?: typeof fetch;                           // override for testing
}

class EStopPoller {
  start(): void;
  stop(): Promise<void>;
}
```

### `notify/types.ts` — Notifier

```typescript
interface Notifier {
  notify(event: NotificationEvent): Promise<void>;
}
```

Implementations: `consoleNotifier`, `webhookNotifier(url)`, `multiNotifier([...])`, and an opt-in `emailNotifier` (loads nodemailer dynamically).

---

## Test strategy

### Coverage thresholds

- **Line coverage**: 100% on `src/**`
- **Branch coverage**: 100% on `src/**`
- **Function coverage**: 100% on `src/**`

Enforced by `vitest --coverage` with `coverage.thresholds.100 = true` in `vitest.config.ts`. CI fails the build on any drop.

### Test categories

1. **Unit tests** (per module): one `.test.ts` per source file. Mock all collaborators. Targets every code path.
2. **Property tests** (audit chain, policy resolution): use `fast-check` to fuzz inputs. Audit chain test: arbitrary sequences of writes followed by `verifyChain` must always succeed. Policy resolver test: arbitrary policy + tool name produces a deterministic decision.
3. **Integration tests** (`tests/integration/`): end-to-end `GuardianRuntime` flows. No mocks; real filesystem (tmpdir), real audit log, real policy store. Cover all event sequences from SPEC §2.4.
4. **Conformance tests** (`tests/conformance/`): consume shared fixtures from the Python repo at `tests/conformance/fixtures/`. Each fixture is a `(input, expected_output)` pair. Both impls must produce the same observable behavior.
5. **Red-team tests** (`tests/red-team/`, v0.4+): adversarial inputs trying to bypass the gate, tamper with the audit log, or trigger spurious E-stops. Preview of the v0.4 `guardian-eval` companion.

### Test infrastructure

- **Test runner**: `vitest` (already in deps).
- **Mocking**: built-in `vi.mock` + `vi.fn`.
- **Filesystem**: `tmp` package for isolated test directories.
- **Time**: `vi.useFakeTimers` for poller / cache TTL tests.
- **HTTP**: `msw` for `asyncCallbackGate` and `EStopPoller` tests.

---

## Cross-language conformance harness

Shared between TS and Python. Lives in the Python repo at `tests/conformance/` (canonical home; both impls pull from there).

Three corpus subdirs:

```
tests/conformance/
├── audit-logs/
│   ├── valid/               # Logs both impls must read + verify chain.
│   │   ├── 01-minimal.jsonl
│   │   ├── 02-with-signatures.jsonl
│   │   ├── 03-multi-session.jsonl
│   │   └── ...
│   └── invalid/             # Logs both impls must reject.
│       ├── 01-broken-chain.jsonl
│       ├── 02-bad-signature.jsonl
│       └── ...
├── policies/
│   ├── valid/
│   │   ├── 01-minimal.yaml + .sig.bin (HMAC over canonical bytes with corpus site key)
│   │   ├── 02-wildcards.yaml + .sig.bin
│   │   └── ...
│   └── invalid/
│       ├── 01-bad-hmac.yaml + .sig.bin
│       └── ...
└── gates/
    ├── request-response-pairs.jsonl   # Each line: { request, expected_response_shape }
    └── decision-semantics/
        ├── allow-session-persists-in-yaml.json
        ├── allow-forever-persists-across-restart.json
        └── ...
```

Each impl runs:

1. Parse every `valid/` fixture; assert success.
2. Parse every `invalid/` fixture; assert specific failure mode.
3. Round-trip: write a record/policy, hand it to the other impl, get back what it parsed; bytes must be identical (for canonical formats) or structurally identical (for serialized objects).

Conformance suite gates v1.0.0 release in both languages.

---

## Implementation order (Phase 3)

Each milestone is a tagged release with 100% coverage on all touched files. Branches off `main`, merged green.

| Milestone | Scope | Files added/changed | Coverage gate |
|---|---|---|---|
| v0.1.0 | `audit/`, `runtime/`, `estop/local.ts`, basic `types.ts` + `errors.ts`. | ~12 files. | 100% on touched. |
| v0.2.0 | `policy/`, `gate/cli.ts`. | ~9 files. | 100%. |
| v0.3.0 | `gate/async-callback.ts`, `gate/programmatic.ts`, `gate/data-channel.ts`. | ~5 files. | 100%. |
| v0.4.0 | `estop/hub.ts`, `estop/middleware.ts`, `estop/poller.ts`. | ~6 files. | 100%. |
| v0.5.0 | `audit/signature.ts`, `bin/guardian-verify.ts`, signature support in writer/reader. | ~4 files. | 100%. |
| v0.6.0 | Model-aware extensions to `policy/evaluator.ts` + `policy/types.ts`. | ~3 files. | 100%. |
| v0.7.0 | `notify/`, wire Notifier into `EStopHub` and `EStopLocal`. | ~7 files. | 100%. |

Tests + integration tests added alongside each milestone. No batched test writing at the end.

---

## Decisions made (closes the open questions from GUARDIAN_AGENT.md)

1. **HMAC key derivation**: site-key file (`.flowdot/site.key` for FlowDot consumers, configurable for others). ✓
2. **`EStopBroadcastChannel`**: generic interface; FlowDot's `comms_daemon_commands` becomes one adapter. ✓
3. **Permission categories**: pluggable. Library ships built-in defaults under `category:<name>` prefix syntax. ✓
4. **Notification fan-out**: library defines `Notifier` interface; FlowDot's `CommsDispatcher` is a host-side adapter outside the library. ✓
5. **Voice/Live `tool/toolkit` scope variant**: merged via `granularity` field on `GateRequest`/`GateResponse`. Data-channel transport is a separate gate adapter. ✓
6. **C-Corp / commercial-license positioning**: AGPL-3.0 + commercial license tier. ✓
7. **Legacy compatibility**: dropped per user direction (pre-alpha, no real users yet). Format choices favor cross-language interop and clean design over migration paths.

---

## Out of scope for v0.1 → v0.7

- Log rotation (consumer's responsibility; revisit in v0.8+).
- Distributed audit-log coordination across multiple processes (single-process per runtime; multi-runtime coordination is a v0.8+ feature).
- Argument redaction (SPEC §3 open question).
- Pluggable audit storage backends beyond JSONL (revisit in v0.8+).
- Bun/Deno targeting (Node 20+ LTS only).
- Browser bundle (Node-only initially; browser-safe subset extractable later).
- C# / Go / Rust reference companions.

Each of these is documented as a non-goal in this design; they will be revisited only on adopter pull.
