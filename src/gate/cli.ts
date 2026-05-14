/**
 * cliApprovalGate — synchronous-feeling stdin prompt. SPEC §4.3.
 */

import { createInterface, Interface } from 'node:readline';

import type { ApprovalGate, GateRequest, GateResponse } from './types.js';

export interface CliGateOptions {
  /** Read line source. Defaults to process.stdin. */
  input?: NodeJS.ReadableStream;
  /** Write target for prompt output. Defaults to process.stderr. */
  output?: NodeJS.WritableStream;
  /** Identifier recorded on every gate response. */
  operatorId?: string;
}

/**
 * Build a CLI approval gate. The returned function is reusable across many
 * calls but is not concurrency-safe: only one prompt at a time.
 */
export function cliApprovalGate(options: CliGateOptions = {}): ApprovalGate {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stderr;
  const operatorId = options.operatorId;

  return async (request: GateRequest): Promise<GateResponse> => {
    const rl = createInterface({ input, output });
    try {
      writePrompt(output, request);
      const answer = await prompt(rl, '> ');
      const decision = parseCliAnswer(answer.trim());
      const out: GateResponse = {
        decision,
        granularity: request.granularity,
      };
      if (operatorId !== undefined) out.operator_id = operatorId;
      return out;
    } finally {
      rl.close();
    }
  };
}

function writePrompt(out: NodeJS.WritableStream, request: GateRequest): void {
  const lines = [
    '',
    '── guardian-agent approval required ──',
    `Tool:      ${request.tool_name}`,
    `Agent:     ${request.agent_id}`,
    `Session:   ${request.session_id}`,
    `Args:      ${JSON.stringify(request.tool_args)}`,
  ];
  if (request.model) {
    lines.push(`Model:     ${request.model.provider}/${request.model.id}`);
  }
  if (request.context) {
    lines.push(`Context:   ${request.context}`);
  }
  lines.push(`Choose:    1=once, 2=session, 3=forever, 4=deny, 5=ban`);
  lines.push('');
  out.write(lines.join('\n') + '\n');
}

/**
 * Parse the user's input. Accepts:
 *   1 / once / allow      → allow
 *   2 / session           → allow_session
 *   3 / forever / always  → allow_forever
 *   4 / deny / no         → deny
 *   5 / ban / never       → ban_forever
 *
 * Any other input falls through to `deny` (fail-closed).
 */
export function parseCliAnswer(answer: string): GateResponse['decision'] {
  const a = answer.toLowerCase();
  if (a === '1' || a === 'once' || a === 'allow' || a === 'y' || a === 'yes') {
    return 'allow';
  }
  if (a === '2' || a === 'session') {
    return 'allow_session';
  }
  if (a === '3' || a === 'forever' || a === 'always' || a === 'always_allow') {
    return 'allow_forever';
  }
  if (a === '5' || a === 'ban' || a === 'never' || a === 'ban_forever') {
    return 'ban_forever';
  }
  // Default: deny (fail-closed). Includes `4`, `deny`, `no`, and unknown input.
  return 'deny';
}

function prompt(rl: Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer));
  });
}
