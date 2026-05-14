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

export interface GuardianRuntimeOptions {
  agentId: string;
  sessionId?: string;
  audit: AuditLogWriter;
  estop?: EStopLocal;
  defaultModel?: ModelAttribution;
}

export interface ToolOptions {
  name?: string;
  model?: ModelAttribution;
}

export class GuardianRuntime {
  readonly agentId: string;
  readonly sessionId: string;
  readonly audit: AuditLogWriter;
  readonly estop: EStopLocal | undefined;
  readonly defaultModel: ModelAttribution | undefined;

  private sessionOpened = false;
  private closed = false;

  constructor(options: GuardianRuntimeOptions) {
    this.agentId = options.agentId;
    this.sessionId = options.sessionId ?? 'sess_' + ulid();
    this.audit = options.audit;
    this.estop = options.estop;
    this.defaultModel = options.defaultModel;
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
      await this.audit.append({
        kind: 'tool_call',
        status: 'pending',
        initiator: 'agent',
        tool: { name: toolName, args: argsToObject(args) },
        ...(model === undefined ? {} : { model: modelToWire(model) }),
      });

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
  input_tokens?: number;
  output_tokens?: number;
} {
  return {
    provider: model.provider,
    id: model.id,
    ...(model.inputTokens === undefined ? {} : { input_tokens: model.inputTokens }),
    ...(model.outputTokens === undefined ? {} : { output_tokens: model.outputTokens }),
  };
}
