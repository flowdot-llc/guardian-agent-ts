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
}

export class GuardianRuntime {
  readonly agentId: string;
  readonly sessionId: string;
  readonly audit: AuditLogWriter;
  readonly estop: EStopLocal | undefined;
  readonly defaultModel: ModelAttribution | undefined;
  readonly honeytokens: HoneytokenSet | undefined;
  readonly capabilityWindow: CapabilityWindow | undefined;

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

      const model = opts?.model ?? this.defaultModel;

      // 1. tool_call (pending)
      const callRecord = await this.audit.append({
        kind: 'tool_call',
        status: 'pending',
        initiator: 'agent',
        tool: { name: toolName, args: argsToObject(args) },
        ...(model === undefined ? {} : { model: modelToWire(model) }),
      });

      // Capability-window accounting + Yellow-line evaluation. Records
      // every dispatched call; fires per-rule matches. v0.8: audit-only —
      // matches do NOT change dispatch behavior. The matches are captured
      // here so the post-dispatch hook can write `x_capability_yellow`
      // adjacent to the tool_call event for forensic clarity.
      const capabilities: CapabilityClass[] = opts?.capabilities ?? ['unknown'];
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
          tool: { name: toolName, args: argsToObject(args) },
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
        tool: { name: toolName, args: argsToObject(args) },
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
          tool: {
            name: toolName,
            args: argsToObject(args),
            duration_ms: durationMs,
          },
          detail: { error: err instanceof Error ? err.message : String(err) },
        });
        throw err;
      }

      const durationMs = Date.now() - startMs;
      await this.audit.append({
        kind: 'tool_result',
        status: 'executed',
        initiator: 'system',
        tool: {
          name: toolName,
          args: argsToObject(args),
          result,
          duration_ms: durationMs,
        },
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
