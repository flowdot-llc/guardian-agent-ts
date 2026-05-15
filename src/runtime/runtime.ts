/**
 * GuardianRuntime — the orchestrator. SPEC §4 / §5.
 *
 * v0.1.0 scope: tool wrapping + audit emission + EStopLocal coordination.
 * Policy and gate are introduced in v0.2/v0.3; v0.1 emits a pre-approved
 * policy_check + tool_result for every tool call so the wire shape is correct
 * even before policy enforcement is wired.
 */

import { ulid } from 'ulidx';

import { GuardianHaltedError } from '../errors.js';
import type { AuditLogWriter } from '../audit/writer.js';
import type { ModelAttribution } from '../types.js';
import type { EStopLocal } from '../estop/local.js';
import type { EStopPressOptions } from '../estop/types.js';
import { checkHoneytoken, type HoneytokenSet } from './honeytokens.js';
import { CapabilityWindow, type CapabilityClass, type CapabilityRule } from './capability.js';
import {
  awaitWithTimeout,
  newGateId,
  type OperatorConfirmationGate,
} from '../gate/two-key.js';

export interface GuardianRuntimeOptions {
  agentId: string;
  sessionId?: string;
  audit: AuditLogWriter;
  estop?: EStopLocal;
  defaultModel?: ModelAttribution;
  /**
   * Honeytoken set scanned against every tool call. A hit fires
   * `x_honeytoken_triggered` + presses the EStop (if configured) + throws
   * `GuardianHaltedError`. SPEC §11. v0.3.0+.
   */
  honeytokens?: HoneytokenSet;
  /**
   * Capability rules evaluated after every dispatched tool call. v0.8 ships
   * Yellow-line only (audit-row, no behavior change). SPEC §4. v0.3.0+.
   */
  capabilityRules?: CapabilityRule[];
  /**
   * Two-key operator gate. When set, tools marked
   * `requiresOperatorConfirmation: true` will suspend pending operator
   * approval. SPEC §4.5. v0.4.0+.
   */
  operatorGate?: OperatorConfirmationGate;
  /** Default timeout for operator confirmations. Default 5 minutes. */
  operatorTimeoutMs?: number;
}

export interface ToolOptions {
  name?: string;
  model?: ModelAttribution;
  /**
   * Capability classes this tool exercises. The runtime feeds these into
   * the {@link CapabilityWindow} after each dispatch so rule combinations
   * can fire `x_capability_yellow` (v0.8) / `x_capability_redline` (v0.10).
   *
   * Untagged tools are recorded with `['unknown']` so they participate in
   * window accounting but never match consumer-defined combinations
   * (unless a rule deliberately names `'unknown'`).
   */
  capabilities?: CapabilityClass[];
  /**
   * When true, the runtime suspends the call before dispatch and calls
   * the configured `operatorGate`. The gate's `denied` response (including
   * timeout-as-denied) throws `GuardianHaltedError`. SPEC §4.5. v0.4.0+.
   *
   * Setting this true with no operator gate configured throws — that's
   * a configuration error, not a runtime fail-closed.
   */
  requiresOperatorConfirmation?: boolean;
  /** Free-text reason recorded on the pending audit row. */
  operatorConfirmationReason?: string;
  /** Per-call timeout override (ms). Default = runtime's operatorTimeoutMs. */
  operatorConfirmationTimeoutMs?: number;
}

export class GuardianRuntime {
  readonly agentId: string;
  readonly sessionId: string;
  readonly audit: AuditLogWriter;
  readonly estop: EStopLocal | undefined;
  readonly defaultModel: ModelAttribution | undefined;
  readonly honeytokens: HoneytokenSet | undefined;
  readonly capabilityWindow: CapabilityWindow | undefined;
  readonly operatorGate: OperatorConfirmationGate | undefined;
  readonly operatorTimeoutMs: number;

  private sessionOpened = false;
  private closed = false;

  constructor(options: GuardianRuntimeOptions) {
    this.agentId = options.agentId;
    this.sessionId = options.sessionId ?? 'sess_' + ulid();
    this.audit = options.audit;
    this.estop = options.estop;
    this.defaultModel = options.defaultModel;
    this.honeytokens = options.honeytokens;
    this.capabilityWindow =
      options.capabilityRules && options.capabilityRules.length > 0
        ? new CapabilityWindow({ rules: options.capabilityRules })
        : undefined;
    this.operatorGate = options.operatorGate;
    this.operatorTimeoutMs = options.operatorTimeoutMs ?? 5 * 60 * 1000;
  }

  /** Open the session. Idempotent. Emits session_open. */
  async openSession(): Promise<void> {
    if (this.sessionOpened) return;
    this.sessionOpened = true;
    await this.audit.append({
      kind: 'session_open',
      status: 'approved',
      initiator: 'system',
    });
  }

  /**
   * Wrap a tool function. Returned function intercepts every call.
   * SPEC §2.4 — emits the documented event sequence.
   */
  tool<Args extends unknown[], Result>(
    fn: (...args: Args) => Promise<Result> | Result,
    opts?: ToolOptions,
  ): (...args: Args) => Promise<Result> {
    const toolName = opts?.name ?? fn.name;
    if (toolName === '' || toolName === undefined) {
      throw new Error('tool() requires a name (either fn.name or opts.name)');
    }
    if (
      toolName.startsWith('guardian.') ||
      toolName.startsWith('runtime.') ||
      toolName.startsWith('internal.')
    ) {
      throw new Error(`tool name "${toolName}" uses a reserved prefix`);
    }

    return async (...args: Args): Promise<Result> => {
      if (!this.sessionOpened) {
        await this.openSession();
      }

      // Honeytoken check fires BEFORE the halt check + audit. A honeytoken
      // hit is itself a halt trigger: we record x_honeytoken_triggered,
      // press the estop (if configured), and throw. Subsequent calls then
      // see the pressed estop and refuse on the normal path.
      if (this.honeytokens) {
        const hit = checkHoneytoken(this.honeytokens, toolName, argsToObject(args));
        if (hit !== null) {
          await this.audit.append({
            kind: 'x_honeytoken_triggered' as unknown as 'policy_check',
            status: 'halted',
            initiator: 'system',
            tool: { name: toolName, args: argsToObject(args) },
            detail: {
              set_id: this.honeytokens.id,
              hit_kind: hit.kind,
              ...(hit.kind === 'value_in_args' ? { token_id: hit.tokenId } : {}),
              ...(hit.kind === 'phantom_tool' ? { tool_name: hit.toolName } : {}),
            },
          });
          if (this.estop) {
            const reason =
              hit.kind === 'value_in_args'
                ? `honeytoken:${hit.tokenId}`
                : `honeytoken:phantom_tool:${hit.toolName}`;
            await this.estop.press({ reason, initiator: 'system' });
          }
          throw new GuardianHaltedError(
            `tool call rejected: honeytoken triggered (${hit.kind})`,
            'honeytoken',
          );
        }
      }

      // Halt check first: if pressed, refuse the call before any audit churn.
      if (this.estop?.isPressed()) {
        await this.audit.append({
          kind: 'policy_check',
          status: 'halted',
          initiator: 'system',
          tool: { name: toolName, args: argsToObject(args) },
          detail: { reason: 'estop' },
        });
        throw new GuardianHaltedError(
          `tool call rejected: emergency stop active`,
          this.estop.getState().pressedReason,
        );
      }

      // Two-key operator authorization. SPEC §4.5. Fires BEFORE tool_call
      // (pending_operator means we haven't decided to dispatch yet).
      // Sequence: pending_operator → gate awaits → approved or denied,
      // all three rows share the same gate_id for correlation.
      if (opts?.requiresOperatorConfirmation) {
        if (!this.operatorGate) {
          throw new Error(
            `tool ${JSON.stringify(toolName)} requires operator confirmation but no operatorGate is configured on the runtime`,
          );
        }
        const gateId = newGateId();
        const timeoutMs = opts.operatorConfirmationTimeoutMs ?? this.operatorTimeoutMs;
        const reason = opts.operatorConfirmationReason ?? 'unspecified';
        await this.audit.append({
          kind: 'policy_check',
          status: 'pending_operator',
          initiator: 'system',
          tool: { name: toolName, args: argsToObject(args) },
          detail: { gate_id: gateId, timeout_ms: timeoutMs, reason },
        });
        const response = await awaitWithTimeout(this.operatorGate, {
          gate_id: gateId,
          tool_name: toolName,
          tool_args: argsToObject(args),
          reason,
          timeout_ms: timeoutMs,
          agent_id: this.agentId,
          session_id: this.sessionId,
        });
        const resolutionDetail: Record<string, unknown> = { gate_id: gateId };
        if (response.operator_id !== undefined) {
          resolutionDetail.operator_id = response.operator_id;
        }
        if (response.reason !== undefined) {
          resolutionDetail.reason = response.reason;
        }
        await this.audit.append({
          kind: 'policy_check',
          status: response.decision,
          initiator: 'operator',
          tool: { name: toolName, args: argsToObject(args) },
          detail: resolutionDetail,
        });
        if (response.decision === 'denied') {
          throw new GuardianHaltedError(
            `tool call rejected: operator ${response.reason === 'timeout' ? 'confirmation timed out' : 'denied'}`,
            `operator:${response.reason ?? 'denied'}`,
          );
        }
      }

      const model = opts?.model ?? this.defaultModel;
      const capabilities: CapabilityClass[] = opts?.capabilities ?? ['unknown'];

      // Build the shared tool sub-object once so capabilities are present
      // on every record this dispatch produces (tool_call, policy_check,
      // tool_result). audit consumers can read the capability tags without
      // consulting an external tagging table.
      const toolBase = {
        name: toolName,
        args: argsToObject(args),
        capabilities,
      };

      // 1. tool_call (pending)
      const callRecord = await this.audit.append({
        kind: 'tool_call',
        status: 'pending',
        initiator: 'agent',
        tool: toolBase,
        ...(model === undefined ? {} : { model: modelToWire(model) }),
      });

      // Capability-window accounting + Yellow-line evaluation. Records
      // every dispatched call; fires per-rule matches. v0.8: audit-only —
      // matches do NOT change dispatch behavior. The matches are captured
      // here so the post-dispatch hook can write `x_capability_yellow`
      // adjacent to the tool_call event for forensic clarity.
      const capabilityMatches = this.capabilityWindow
        ? this.capabilityWindow.record(capabilities, callRecord.event_id)
        : [];
      for (const match of capabilityMatches) {
        await this.audit.append({
          kind: (match.level === 'yellow'
            ? 'x_capability_yellow'
            : 'x_capability_redline') as unknown as 'policy_check',
          status: 'approved',
          initiator: 'system',
          tool: toolBase,
          detail: {
            rule_id: match.ruleId,
            combination: match.combination,
            window_ms: match.window_ms,
            contributing_event_ids: match.contributingEventIds,
            tool_capabilities: capabilities,
          },
        });
        // v0.8: Yellow does not change behavior. Red-line auto-stop ships
        // in v0.10 — explicitly NOT wired here. When v0.10 lands, the
        // estop.press() call goes inside this `if`.
      }

      // 2. policy_check (approved) — v0.1 is fail-open; v0.2 wires real policy.
      await this.audit.append({
        kind: 'policy_check',
        status: 'approved',
        initiator: 'system',
        tool: toolBase,
        detail: { matched_at: 'default' },
      });

      // 3. execute
      const startMs = Date.now();
      let result: Result;
      try {
        result = await fn(...args);
      } catch (err) {
        const durationMs = Date.now() - startMs;
        await this.audit.append({
          kind: 'tool_result',
          status: 'errored',
          initiator: 'system',
          tool: { ...toolBase, duration_ms: durationMs },
          detail: { error: err instanceof Error ? err.message : String(err) },
        });
        throw err;
      }

      const durationMs = Date.now() - startMs;
      await this.audit.append({
        kind: 'tool_result',
        status: 'executed',
        initiator: 'system',
        tool: { ...toolBase, result, duration_ms: durationMs },
      });

      return result;
    };
  }

  /** Trip the local emergency-stop. No-op if no EStopLocal was provided. */
  async pressEStop(options: EStopPressOptions): Promise<void> {
    if (!this.estop) {
      throw new Error('GuardianRuntime constructed without an EStopLocal');
    }
    await this.estop.press(options);
  }

  /** Close the runtime: emit session_close, drain audit queue. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.sessionOpened) {
      await this.audit.append({
        kind: 'session_close',
        status: 'approved',
        initiator: 'system',
      });
    }
    await this.audit.close();
  }
}

function argsToObject(args: readonly unknown[]): Record<string, unknown> {
  // Wire shape requires args to be an object. We wrap positional args as
  // { "0": ..., "1": ..., ... } for stable serialization.
  const out: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i++) {
    out[String(i)] = args[i];
  }
  return out;
}

function modelToWire(model: ModelAttribution): {
  provider: string;
  id: string;
  surface?: string;
  aggregator?: string;
  input_tokens?: number;
  output_tokens?: number;
} {
  return {
    provider: model.provider,
    id: model.id,
    ...(model.surface === undefined ? {} : { surface: model.surface }),
    ...(model.aggregator === undefined ? {} : { aggregator: model.aggregator }),
    ...(model.inputTokens === undefined ? {} : { input_tokens: model.inputTokens }),
    ...(model.outputTokens === undefined ? {} : { output_tokens: model.outputTokens }),
  };
}
