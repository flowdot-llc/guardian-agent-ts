/**
 * Tests for the v0.2.0 policy gate wiring inside `GuardianRuntime.tool()`.
 * Covers fail-open default, allow / deny / prompt paths, drill-down pattern
 * matching, `when`-clause model gating, persist_as round-trip, and the
 * default drilldown_axes builder.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditLogWriter } from '../../src/audit/writer.js';
import { AuditLogReader } from '../../src/audit/reader.js';
import { GuardianRuntime } from '../../src/runtime/runtime.js';
import { PolicyDenialError } from '../../src/errors.js';
import { PolicyEvaluator } from '../../src/policy/evaluator.js';
import { PolicyStore } from '../../src/policy/store.js';
import { policyStoreGate } from '../../src/policy/gate-adapter.js';
import { callbackOperatorGate } from '../../src/gate/two-key.js';
import type {
  PolicyGate,
  PolicyIdentifierFn,
} from '../../src/runtime/runtime.js';
import type { Policy } from '../../src/policy/types.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'guardian-policy-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function readAll(path: string) {
  const reader = await AuditLogReader.open(path);
  const records = [];
  for await (const r of reader.records()) records.push(r);
  await reader.close();
  return records;
}

/** Convenience: build a runtime over a fresh audit log. */
function buildRuntime(
  audit: AuditLogWriter,
  extra: Partial<ConstructorParameters<typeof GuardianRuntime>[0]> = {},
): GuardianRuntime {
  return new GuardianRuntime({
    agentId: 'test',
    sessionId: 'sess',
    audit,
    ...extra,
  });
}

/** Default identifier extractor: `mcp__server__tool` → `mcp.tool:server/tool`,
 *  `toolkit__slug__tool` → `toolkit.tool:slug/tool`, `llm.call` → `llm.call:<...model>`,
 *  anything else → `tool:<name>`. Mirrors the FlowDot supervisor convention. */
const defaultIdentifier: PolicyIdentifierFn = (call) => {
  const { name, model } = call;
  if (name.startsWith('mcp__')) {
    const rest = name.slice('mcp__'.length);
    const split = rest.indexOf('__');
    if (split < 0) return `mcp.tool:${rest}`;
    return `mcp.tool:${rest.slice(0, split)}/${rest.slice(split + 2)}`;
  }
  if (name.startsWith('toolkit__')) {
    const rest = name.slice('toolkit__'.length);
    const split = rest.indexOf('__');
    if (split < 0) return `toolkit.tool:${rest}`;
    return `toolkit.tool:${rest.slice(0, split)}/${rest.slice(split + 2)}`;
  }
  if (name === 'llm.call' && model !== undefined) {
    const agg = model.aggregator ?? 'direct';
    return `llm.call:${agg}/${model.provider}/${model.id}`;
  }
  return `tool:${name}`;
};

describe('GuardianRuntime policy gate (v0.2)', () => {
  it('preserves fail-open behavior when no policy gate is configured', async () => {
    const audit = new AuditLogWriter({
      path: join(tmp, 'audit.jsonl'),
      agentId: 'test',
      sessionId: 'sess',
    });
    const rt = buildRuntime(audit);
    const inc = rt.tool(async (x: number) => x + 1, { name: 'inc' });
    await inc(2);
    await rt.close();

    const recs = await readAll(join(tmp, 'audit.jsonl'));
    const policy = recs.find((r) => r.kind === 'policy_check');
    expect(policy?.status).toBe('approved');
    expect(policy?.detail).toMatchObject({ matched_at: 'default' });
  });

  it('emits policy_check with category+identifier when gate is configured', async () => {
    const policy: Policy = {
      version: '0.2',
      agent_id: 'test',
      defaults: { scope: 'forever', decision: 'allow' },
      rules: [],
    };
    const gate: PolicyGate = {
      evaluate: (n, m) => new PolicyEvaluator(policy).evaluate(n, m),
    };
    const audit = new AuditLogWriter({
      path: join(tmp, 'audit.jsonl'),
      agentId: 'test',
      sessionId: 'sess',
    });
    const rt = buildRuntime(audit, { policy: gate, policyIdentifier: defaultIdentifier });
    const ls = rt.tool(async () => ['workflow-a'], { name: 'mcp__flowdot__list_workflows' });
    await ls();
    await rt.close();

    const recs = await readAll(join(tmp, 'audit.jsonl'));
    const policyRow = recs.find((r) => r.kind === 'policy_check');
    expect(policyRow?.status).toBe('approved');
    expect(policyRow?.detail).toMatchObject({
      category: 'mcp.tool',
      identifier: 'flowdot/list_workflows',
      policy_identifier: 'mcp.tool:flowdot/list_workflows',
      decision: 'allow',
    });
  });

  it('denies the call when policy.deny matches', async () => {
    const policy: Policy = {
      version: '0.2',
      agent_id: 'test',
      defaults: { scope: 'prompt' },
      rules: [{ tool: 'mcp.tool:youtube/delete_video', scope: 'banned' }],
    };
    const gate: PolicyGate = {
      evaluate: (n, m) => new PolicyEvaluator(policy).evaluate(n, m),
    };
    const audit = new AuditLogWriter({
      path: join(tmp, 'audit.jsonl'),
      agentId: 'test',
      sessionId: 'sess',
    });
    const rt = buildRuntime(audit, { policy: gate, policyIdentifier: defaultIdentifier });
    let dispatched = false;
    const fn = rt.tool(
      async () => {
        dispatched = true;
        return 'ok';
      },
      { name: 'mcp__youtube__delete_video' },
    );

    await expect(fn()).rejects.toBeInstanceOf(PolicyDenialError);
    expect(dispatched).toBe(false);
    await rt.close();

    const recs = await readAll(join(tmp, 'audit.jsonl'));
    const policyRow = recs.find((r) => r.kind === 'policy_check');
    expect(policyRow?.status).toBe('denied');
    expect(policyRow?.detail).toMatchObject({
      category: 'mcp.tool',
      identifier: 'youtube/delete_video',
      decision: 'deny',
      scope: 'banned',
    });
    // No tool_result row (call never dispatched, but tool_call IS logged
    // before the denial — that's the intent record).
    expect(recs.find((r) => r.kind === 'tool_result')).toBeUndefined();
  });

  it('routes to operator gate on prompt and persists the chosen drill-down', async () => {
    const store = new PolicyStore({ dir: tmp, agentId: 'test', defaultScope: 'prompt' });
    const gate = policyStoreGate(store);
    let receivedContext: unknown = undefined;
    const operatorGate = callbackOperatorGate(async (req) => {
      receivedContext = req.policy_context;
      // Operator picks "any tool on this MCP server, forever, allow".
      return {
        decision: 'approved',
        operator_id: 'op-1',
        persist_as: {
          tool: 'mcp.tool:youtube/*',
          scope: 'forever',
          decision: 'allow',
          notes: 'approved via test',
        },
      };
    });
    const audit = new AuditLogWriter({
      path: join(tmp, 'audit.jsonl'),
      agentId: 'test',
      sessionId: 'sess',
    });
    const rt = buildRuntime(audit, {
      policy: gate,
      policyIdentifier: defaultIdentifier,
      operatorGate,
    });
    const listFn = rt.tool(async () => ['vid-a'], { name: 'mcp__youtube__list_videos' });
    await listFn();

    // The gate should have received the drill-down context.
    expect(receivedContext).toMatchObject({
      category: 'mcp.tool',
      exact_identifier: 'youtube/list_videos',
      policy_identifier: 'mcp.tool:youtube/list_videos',
    });
    const axes = (receivedContext as { drilldown_axes: unknown[] }).drilldown_axes;
    expect(axes.length).toBeGreaterThanOrEqual(3);

    // Subsequent call for the same MCP server should match the new
    // forever-allow rule WITHOUT firing the gate again.
    let secondPromptFired = false;
    const otherFn = rt.tool(
      async () => ['vid-b'],
      { name: 'mcp__youtube__get_video' },
    );
    // Swap in a gate that throws if invoked.
    const rt2 = buildRuntime(
      new AuditLogWriter({
        path: join(tmp, 'audit2.jsonl'),
        agentId: 'test',
        sessionId: 'sess2',
      }),
      {
        policy: gate,
        policyIdentifier: defaultIdentifier,
        operatorGate: callbackOperatorGate(async () => {
          secondPromptFired = true;
          return { decision: 'denied', reason: 'should not be called' };
        }),
      },
    );
    const otherFnUnderRt2 = rt2.tool(
      async () => ['vid-b'],
      { name: 'mcp__youtube__get_video' },
    );
    await otherFnUnderRt2();
    void otherFn;
    expect(secondPromptFired).toBe(false);

    await rt.close();
    await rt2.close();
  });

  it('denies a prompt with no operator gate configured', async () => {
    const policy: Policy = {
      version: '0.2',
      agent_id: 'test',
      defaults: { scope: 'prompt' },
      rules: [],
    };
    const gate: PolicyGate = {
      evaluate: (n, m) => new PolicyEvaluator(policy).evaluate(n, m),
    };
    const audit = new AuditLogWriter({
      path: join(tmp, 'audit.jsonl'),
      agentId: 'test',
      sessionId: 'sess',
    });
    const rt = buildRuntime(audit, { policy: gate, policyIdentifier: defaultIdentifier });
    const fn = rt.tool(async () => 1, { name: 'mcp__x__y' });
    await expect(fn()).rejects.toBeInstanceOf(PolicyDenialError);
    await rt.close();

    const recs = await readAll(join(tmp, 'audit.jsonl'));
    const policyRow = recs.find((r) => r.kind === 'policy_check');
    expect(policyRow?.status).toBe('denied');
    expect(policyRow?.detail).toMatchObject({ reason: 'no_operator_gate' });
  });

  it('drill-down: glob `mcp.tool:youtube/*` matches youtube/list_videos but not github/list_videos', async () => {
    const policy: Policy = {
      version: '0.2',
      agent_id: 'test',
      defaults: { scope: 'prompt' },
      rules: [
        { tool: 'mcp.tool:youtube/*', scope: 'forever', decision: 'allow' },
        { tool: 'mcp.tool:github/*', scope: 'banned' },
      ],
    };
    const evaluator = new PolicyEvaluator(policy);
    expect(evaluator.evaluate('mcp.tool:youtube/list_videos').decision).toBe('allow');
    expect(evaluator.evaluate('mcp.tool:youtube/get_video').decision).toBe('allow');
    expect(evaluator.evaluate('mcp.tool:github/create_issue').decision).toBe('deny');
    expect(evaluator.evaluate('mcp.tool:slack/post_message').decision).toBe('prompt');
  });

  it('when-clause: matches on model.provider', async () => {
    const policy: Policy = {
      version: '0.2',
      agent_id: 'test',
      defaults: { scope: 'prompt' },
      rules: [
        {
          tool: 'llm.call:*',
          scope: 'forever',
          decision: 'allow',
          when: { 'model.provider': 'anthropic' },
        },
      ],
    };
    const gate: PolicyGate = {
      evaluate: (n, m) => new PolicyEvaluator(policy).evaluate(n, m),
    };
    const audit = new AuditLogWriter({
      path: join(tmp, 'audit.jsonl'),
      agentId: 'test',
      sessionId: 'sess',
    });
    let prompted = false;
    const operatorGate = callbackOperatorGate(async () => {
      prompted = true;
      return { decision: 'denied' };
    });
    const rt = buildRuntime(audit, {
      policy: gate,
      policyIdentifier: defaultIdentifier,
      operatorGate,
    });
    // Anthropic should match the allow rule.
    const claude = rt.tool(async () => 'ok', {
      name: 'llm.call',
      model: { aggregator: 'redpill', provider: 'anthropic', id: 'claude-haiku-4.5' },
    });
    await claude();
    expect(prompted).toBe(false);
    // OpenAI should fall through to prompt.
    const gpt = rt.tool(async () => 'ok', {
      name: 'llm.call',
      model: { aggregator: 'redpill', provider: 'openai', id: 'gpt-4o' },
    });
    await expect(gpt()).rejects.toBeInstanceOf(PolicyDenialError);
    expect(prompted).toBe(true);

    await rt.close();
  });

  it('policyStoreGate adapter persists rules and re-reads them in subsequent evaluate() calls', async () => {
    const store = new PolicyStore({ dir: tmp, agentId: 'test', defaultScope: 'prompt' });
    const gate = policyStoreGate(store);

    // Initially no rule for mcp.tool:slack/*.
    expect(gate.evaluate('mcp.tool:slack/post_message').decision).toBe('prompt');

    // Persist a forever-allow.
    await gate.persist!({
      tool: 'mcp.tool:slack/*',
      scope: 'forever',
      decision: 'allow',
      notes: 'unit test',
    });

    // Same gate should now allow.
    expect(gate.evaluate('mcp.tool:slack/post_message').decision).toBe('allow');
  });

  it('skips policy entirely when identifier extractor returns null', async () => {
    let evaluated = false;
    const gate: PolicyGate = {
      evaluate: () => {
        evaluated = true;
        return { decision: 'deny', matchedRule: undefined, matchedAt: 'default', scope: 'banned' };
      },
    };
    const audit = new AuditLogWriter({
      path: join(tmp, 'audit.jsonl'),
      agentId: 'test',
      sessionId: 'sess',
    });
    const rt = buildRuntime(audit, {
      policy: gate,
      policyIdentifier: () => null,
    });
    const fn = rt.tool(async () => 'ok', { name: 'special-tool' });
    await fn();
    expect(evaluated).toBe(false);
    await rt.close();
    const recs = await readAll(join(tmp, 'audit.jsonl'));
    const policyRow = recs.find((r) => r.kind === 'policy_check');
    expect(policyRow?.status).toBe('approved');
    expect(policyRow?.detail).toMatchObject({ matched_at: 'default' });
  });

  it('default drill-down axes contain exact + container + category for mcp.tool', async () => {
    const store = new PolicyStore({ dir: tmp, agentId: 'test', defaultScope: 'prompt' });
    const gate = policyStoreGate(store);
    let context: unknown = undefined;
    const operatorGate = callbackOperatorGate(async (req) => {
      context = req.policy_context;
      return { decision: 'denied' };
    });
    const audit = new AuditLogWriter({
      path: join(tmp, 'audit.jsonl'),
      agentId: 'test',
      sessionId: 'sess',
    });
    const rt = buildRuntime(audit, {
      policy: gate,
      policyIdentifier: defaultIdentifier,
      operatorGate,
    });
    const fn = rt.tool(async () => 'ok', { name: 'mcp__youtube__list_videos' });
    await expect(fn()).rejects.toBeInstanceOf(PolicyDenialError);
    await rt.close();

    const axes = (context as { drilldown_axes: Array<{ key: string; pattern: string }> })
      .drilldown_axes;
    const byKey = Object.fromEntries(axes.map((a) => [a.key, a.pattern]));
    expect(byKey.exact).toBe('mcp.tool:youtube/list_videos');
    expect(byKey.container).toBe('mcp.tool:youtube/*');
    expect(byKey.category).toBe('mcp.tool:*');
  });

  it('persist_as with no persist hook is silently no-op (decision still applies)', async () => {
    const policy: Policy = {
      version: '0.2',
      agent_id: 'test',
      defaults: { scope: 'prompt' },
      rules: [],
    };
    // Gate with no `persist`.
    const gate: PolicyGate = {
      evaluate: (n, m) => new PolicyEvaluator(policy).evaluate(n, m),
    };
    const operatorGate = callbackOperatorGate(async () => ({
      decision: 'approved',
      persist_as: { tool: 'mcp.tool:youtube/*', scope: 'forever', decision: 'allow' },
    }));
    const audit = new AuditLogWriter({
      path: join(tmp, 'audit.jsonl'),
      agentId: 'test',
      sessionId: 'sess',
    });
    const rt = buildRuntime(audit, {
      policy: gate,
      policyIdentifier: defaultIdentifier,
      operatorGate,
    });
    const fn = rt.tool(async () => 'ok', { name: 'mcp__youtube__list_videos' });
    await expect(fn()).resolves.toBe('ok');
    await rt.close();
  });
});
