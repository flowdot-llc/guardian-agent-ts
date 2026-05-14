# ETHOS — FlowDot → guardian-agent extraction map

Internal mapping doc. Records which file or pattern in the FlowDot codebase becomes which construct in the library. The library exists to make these portable; everything below is the ground truth.

Last updated 2026-05-13.

---

## E-stop (PANIC)

FlowDot ships a hub-coordinated emergency-stop ("PANIC") system. The library's `estop/` module is a direct extraction.

| FlowDot source | Library destination |
|---|---|
| `Flow-Docs/DevGuides/PANIC.md` | The canonical design doc. SPEC §5 is the language-neutral version. |
| `FlowDot-Hub/app/Models/UserPanicState.php` | `EStopHub.PressedState` (TypeScript). Sticky-flag state with `pressedAt` / `clearedAt`. |
| `FlowDot-Hub/app/Services/PanicCoordinator.php` | `EStopHub` adapter. Provides `press()`, `clear()`, `status()`, `events()`. |
| `FlowDot-Hub/app/Http/Middleware/EnsureNotPanicked.php` | `createEStopMiddleware()` — Express/Connect/Fastify factory; returns HTTP 423 when pressed. |
| `FlowDot-Hub/app/Http/Controllers/Api/PanicController.php` | Reference HTTP adapter that wires `EStopHub` to a web framework. |
| `FlowDot/server/src/services/panic/panicState.js` | `EStopLocal` — per-process AbortController registry. |
| `flowdot-cli/packages/core/src/panic/panicLocal.ts` | `EStopLocalHandler` interface; reference impl in `estop/local.ts`. Aborts in-flight LLM SSE explicitly. |
| `flowdot-cli/packages/core/src/panic/panicPoller.ts` | `createEStopPoller({intervalMs, statusUrl})` — pull-based safety net. |
| `flowdot-cli/packages/core/src/comms/daemon/DaemonState.ts` (panic handler intercept) | `EStopBroadcastChannel` interface — extension point for surface-specific transports (e.g., FlowDot's `comms_daemon_commands` poll). |
| `FlowDot-Hub/app/Notifications/PanicPressedNotification.php`, `PanicClearedNotification.php` | `notify/` module — `Notifier` interface + reference adapters (console, webhook, email). The PHP Mailable becomes a webhook payload schema. |

### Behaviors preserved verbatim

- **1-second cache TTL on `isPressed`** — implemented as in-library cache in `EStopHub`. SPEC §5.4.
- **HTTP 423 Locked** for blocked routes — implemented in `createEStopMiddleware`. SPEC §5.4.
- **`x-flowdot-mode` rejection of `recipe`/`goal`** — generalized in SPEC §7 as `initiator: agent` rejection on `estop_clear`. `EStopHub.clear()` accepts an `initiator` argument and refuses `agent`.
- **`password.confirm` recent-auth for clear** — the library does not implement password auth itself, but `EStopHub.clear()` accepts a `proofOfRecentAuth` callback the host must supply. Returning `false` causes the clear to return a structured "auth required" response.
- **Two-tap arming** — UX convention, not library code. Documented in SPEC §5.5 as a recommendation.
- **Local instant feedback before network call** — `EStopHub.press()` always returns a tuple `(localHaltDone, remoteAck)` where `localHaltDone` resolves immediately after the local runtime is aborted, before the network call lands.
- **Per-user scoping** — every method on `EStopHub` is bound to a single user identity; cross-user methods do not exist.
- **Append-only audit** — `estop_press` and `estop_clear` records flow through the same `AuditLogWriter` as every other event.

---

## Tool-permission scoping

FlowDot has two existing layers that the library unifies into one.

| FlowDot source | Library destination |
|---|---|
| `flowdot-cli/packages/core/src/services/localPermissions.ts` (origin) | `policy/store.ts` — `PolicyStore` class. |
| `FlowDot-Native/src/main/services/permissionService.ts` (Native port) | Same destination — the Native impl is a port of the CLI one; the library replaces both. |
| HMAC integrity scheme (machine-derived key) | **Replaced** with `site.key` file (SPEC §3.5). The original scheme breaks cross-language interop; the site-key replacement is what the library ships. |
| `.flowdot/permissions.json` | `permissions.yaml` (YAML preferred over JSON for human review; SPEC §3.1). Format change accepted because we are pre-alpha with no users to migrate. |
| `.flowdot/session.json` | `session.yaml`. Same rationale. |
| Permission categories (`command-execute`, `file-read`, etc.) | `policy/categories.ts` — built-in enum + `category:<name>` prefix syntax (SPEC §3.7). |
| Resolution order (banned > forever > session > prompt) | `policy/evaluator.ts` — SPEC §3.3. |
| Wildcard `*` after exact match | `policy/evaluator.ts` — SPEC §3.4. |
| Voice-permissions `tool/toolkit` scope variant in `localStorage` | Unified into the main scope model via the `granularity` field on gate requests/responses (SPEC §4.3). The data-channel transport is a separate gate adapter (`dataChannelGate`). |
| `ToolPermissionModal.tsx` (5 buttons) | UX, not library. The library's gate adapter contract supports the 5 decision values: `allow`, `allow_session`, `allow_forever`, `deny`, `ban_forever` (SPEC §4.2). |

### Behaviors preserved verbatim

- **Banned beats allow at every layer** — SPEC §3.3.
- **HMAC integrity on `permissions.yaml`** — SPEC §3.5.
- **Fail-closed on integrity failure** — SPEC §3.5 mandates rejecting the file on HMAC failure and treating policy as empty.
- **`0o700` directories, `0o600` files** — SPEC §3.6.
- **Reserved tool-name prefixes** (`guardian.`, `runtime.`, `internal.`) — SPEC §3.4.

### Deliberately changed

- **HMAC key derivation**: was machine-derived from `os.hostname() + ...`. Now `site.key` file (32 random bytes, generated on first run). Reason: cross-language interop. We can do this freely because no real users exist yet.
- **File format**: was JSON, now YAML for human review. Same reason.
- **Scope vocabulary**: `forever` replaces `permanent` to match FlowDot's user-facing terminology in the CLI/Native UIs (less precious, more direct).

---

## Audit log

FlowDot has several audit streams; none has a hash chain or signatures today. The library closes that gap.

| FlowDot source | Library destination |
|---|---|
| `FlowDot-Hub` `panic_events` table | One `kind: estop_press` or `kind: estop_clear` audit record per row, plus the existing DB row. Library writes to JSONL; FlowDot's adapter mirrors to DB. |
| `SecurityAuditService` (Hub) | Optional second sink via `AuditLogWriter` composition: write the same record to multiple destinations. |
| `localLogService` (Native, `.flowdot/logs/`) | The library's `audit.jsonl` replaces this for supervisor events. Verbose run logs are FlowDot's concern, not the library's. |
| Hash chain | **New in library**. `audit/chain.ts` implements SPEC §2.5. |
| ed25519 signatures | **New in library**. `audit/signature.ts` lands in v0.5.0. |

### Behaviors preserved verbatim

- **Append-only** — `AuditLogWriter` opens in append mode, never seeks backward. No `unlink` of past records.
- **Per-user scoping** — every record carries `agent_id` and `session_id`; the audit log does not aggregate across users.
- **Indexed by user/agent** — JSONL is sequential, but the `event_id` field is ULID (lexically sortable). External readers can index as they wish.

---

## HITL approval gate

| FlowDot source | Library destination |
|---|---|
| `FlowDot-Native` `PermissionDialog` (IPC pipeline) | `gate/programmatic.ts` — the library exposes a callable; FlowDot's Electron renderer wraps it. |
| `FlowDot-Native` `ToolPermissionModal` (voice/live) | `gate/data-channel.ts` — encodes/decodes the data-channel frames. |
| CLI prompt | `gate/cli.ts` — sync stdin prompt. |
| Web/native via HTTP | `gate/async-callback.ts` — POSTs request, awaits JSON response. |

### Frame shapes

The data-channel frames (`tool_event`, `tool_permission_request`, `tool_permission_response`) become typed payloads in `gate/data-channel.ts`. Backward compat with FlowDot's existing wire shapes is preserved deliberately so the library can be slipped into the Live/Voice surface without changing the worker.

---

## Notification fan-out

| FlowDot source | Library destination |
|---|---|
| `app(CommsDispatcher::class)->sendToUser($userId, $message)` | `notify/notifier.ts` — `Notifier` interface; FlowDot supplies a `CommsDispatcherNotifier` adapter outside the library. |
| `Mail\PanicPressedMail`, `Mail\PanicClearedMail` | `notify/email.ts` — SMTP reference adapter. FlowDot's Mailables become FlowDot-side templates. |
| Mobile push via existing notification service | Not in library; FlowDot supplies via its `Notifier` adapter. |
| Signed URLs (`URL::signedRoute`) | `notify/signed-url.ts` — optional helper for adapters that want to include a tamper-evident clear link. |

---

## Cross-surface storage

| Pattern | Library treatment |
|---|---|
| `.flowdot/` directory under CWD | The library writes to a configurable `dir` option (default `./.guardian/` for non-FlowDot consumers; FlowDot passes `./.flowdot/` to keep its existing layout). |
| `0o700` dirs / `0o600` files | Enforced by `policy/store.ts` and `audit/writer.ts`. |
| Cross-process advisory file locks | `policy/lock.ts` — wraps `proper-lockfile` for both POSIX and Windows. |
| Secure-delete (3-pass overwrite) | `policy/store.ts.deleteSecure(path)`. Used on `permissions.yaml` and `site.key` deletion. |
| Version bump on incompatible shape change | The library uses SPEC version (§9). FlowDot's surface adapters use `LOCAL_CHAT_INDEX_VERSION`-style internal versions for their own files. |

---

## Items deliberately NOT extracted

These are FlowDot-specific and stay in FlowDot, not the library:

- **`comms_daemon_commands` poll mechanism** — the library exposes `EStopBroadcastChannel` interface; FlowDot's daemon command table is one implementation. Researchers use the in-process implementation; FlowDot uses theirs.
- **`x-flowdot-source` and `x-flowdot-mode` HTTP headers** — generalized as `initiator` field on records and request bodies (SPEC §7). Headers remain a FlowDot-side concern.
- **`UserPanicState` Eloquent model + DB migration** — Laravel-specific. The library defines the data shape via SPEC §5.4; FlowDot's PHP keeps its model.
- **Filament admin UI** — UI-specific, not in library.
- **VR Unity adapter** — out of scope for both TS and Python; future C# companion possible at v1.x.
- **`/observability` page** — UI rendering of audit data; library produces the data, surface renders.
- **MCP-specific rate limits** (3/hr per token) — FlowDot's deployment policy; library does not impose rate limits on its own callers.

---

## Items expanded beyond what FlowDot has today

- **ed25519 signatures on audit records** — FlowDot has hash-evident audit but not signed audit. Library adds this in v0.5.0.
- **Model-aware policy rules** — `model.provider` + `model.id` wildcards (e.g., `claude-*-4.5*`). FlowDot's existing permission service is model-agnostic. Lands in v0.6.0.
- **Cross-language conformance fixtures** — FlowDot has surface-specific tests; the library introduces a shared corpus that both TS and Python must round-trip.
- **`guardian-verify` CLI** — log integrity verification tool; lands with v0.5.0.

---

## Open implementation questions

1. **Audit-log rotation**: FlowDot uses log rotation via OS tooling. The library writes to a single JSONL; consumers handle rotation. Should the library ship a rotation helper? **Decision deferred to v0.4+.**
2. **Async vs. sync writes**: TS impl writes asynchronously; Python impl will use `aiofiles`. The hash chain requires strict ordering; both impls use an in-memory queue + single writer. **Resolved**: in-library write queue.
3. **Cross-language HMAC compatibility**: site-key bytes are read identically by both languages, HMAC-SHA256 is identical, the canonical-form YAML serialization is the only risk. **Resolved**: use canonical YAML via `yaml` (TS) / `ruamel.yaml --canonical` (Python). Cross-language test fixtures in conformance suite.

---

This doc updates as we ship each milestone. The link between FlowDot source and library destination is the contract we maintain across phases.
