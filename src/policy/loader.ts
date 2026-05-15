/**
 * Parse + validate a Policy. SPEC §3.1.
 */

import { parse as parseYaml } from 'yaml';

import { GuardianConfigError } from '../errors.js';
import type { Policy, PolicyRule, PolicyScope } from './types.js';

const VALID_SCOPES: readonly PolicyScope[] = ['once', 'session', 'forever', 'banned'];
const VALID_DEFAULT_SCOPES: readonly string[] = ['prompt', ...VALID_SCOPES];

/** Parse a YAML string into a validated Policy. */
export function parsePolicy(yaml: string): Policy {
  const raw = parseYaml(yaml) as unknown;
  return validatePolicy(raw);
}

/** Validate a parsed object as a Policy. Throws GuardianConfigError on issues. */
export function validatePolicy(raw: unknown): Policy {
  if (!isObject(raw)) {
    throw new GuardianConfigError('policy must be an object');
  }
  const version = raw.version;
  if (typeof version !== 'string' || version.length === 0) {
    throw new GuardianConfigError('policy.version must be a non-empty string');
  }
  const agent_id = raw.agent_id;
  if (typeof agent_id !== 'string' || agent_id.length === 0) {
    throw new GuardianConfigError('policy.agent_id must be a non-empty string');
  }

  const defaultsRaw = raw.defaults;
  if (!isObject(defaultsRaw)) {
    throw new GuardianConfigError('policy.defaults must be an object');
  }
  const defaultsScope = defaultsRaw.scope;
  if (typeof defaultsScope !== 'string' || !VALID_DEFAULT_SCOPES.includes(defaultsScope)) {
    throw new GuardianConfigError(
      `policy.defaults.scope must be one of ${VALID_DEFAULT_SCOPES.join(', ')}`,
    );
  }
  const defaultsDecision = defaultsRaw.decision;
  if (defaultsDecision !== undefined && defaultsDecision !== 'allow' && defaultsDecision !== 'deny') {
    throw new GuardianConfigError('policy.defaults.decision must be "allow" or "deny" if set');
  }

  const rulesRaw = raw.rules;
  if (rulesRaw !== undefined && !Array.isArray(rulesRaw)) {
    throw new GuardianConfigError('policy.rules must be an array if present');
  }
  const rules: PolicyRule[] = [];
  if (Array.isArray(rulesRaw)) {
    for (let i = 0; i < rulesRaw.length; i++) {
      rules.push(validateRule(rulesRaw[i], i));
    }
  }

  const defaults: Policy['defaults'] = {
    scope: defaultsScope as Policy['defaults']['scope'],
  };
  if (defaultsDecision !== undefined) {
    defaults.decision = defaultsDecision as Exclude<Policy['defaults']['decision'], undefined>;
  }

  return {
    version,
    agent_id,
    defaults,
    rules,
  };
}

function validateRule(raw: unknown, index: number): PolicyRule {
  if (!isObject(raw)) {
    throw new GuardianConfigError(`rule[${index}] must be an object`);
  }
  const tool = raw.tool;
  if (typeof tool !== 'string' || tool.length === 0) {
    throw new GuardianConfigError(`rule[${index}].tool must be a non-empty string`);
  }
  if (
    tool.startsWith('guardian.') ||
    tool.startsWith('runtime.') ||
    tool.startsWith('internal.')
  ) {
    throw new GuardianConfigError(`rule[${index}].tool uses a reserved prefix`);
  }
  const scope = raw.scope;
  if (typeof scope !== 'string' || !VALID_SCOPES.includes(scope as PolicyScope)) {
    throw new GuardianConfigError(
      `rule[${index}].scope must be one of ${VALID_SCOPES.join(', ')}`,
    );
  }
  const decision = raw.decision;
  if (decision !== undefined && decision !== 'allow' && decision !== 'deny') {
    throw new GuardianConfigError(
      `rule[${index}].decision must be "allow" or "deny" if set`,
    );
  }
  const notes = raw.notes;
  if (notes !== undefined && typeof notes !== 'string') {
    throw new GuardianConfigError(`rule[${index}].notes must be a string if set`);
  }
  const when = raw.when;
  let validatedWhen: PolicyRule['when'];
  if (when !== undefined) {
    if (!isObject(when)) {
      throw new GuardianConfigError(`rule[${index}].when must be an object if set`);
    }
    validatedWhen = {};
    if (when['model.provider'] !== undefined) {
      if (typeof when['model.provider'] !== 'string') {
        throw new GuardianConfigError(`rule[${index}].when['model.provider'] must be a string`);
      }
      validatedWhen['model.provider'] = when['model.provider'];
    }
    if (when['model.id'] !== undefined) {
      if (typeof when['model.id'] !== 'string') {
        throw new GuardianConfigError(`rule[${index}].when['model.id'] must be a string`);
      }
      validatedWhen['model.id'] = when['model.id'];
    }
    if (when.attribution_path !== undefined) {
      if (typeof when.attribution_path !== 'string') {
        throw new GuardianConfigError(`rule[${index}].when.attribution_path must be a string`);
      }
      validatedWhen.attribution_path = when.attribution_path;
    }
  }

  const out: PolicyRule = {
    tool,
    scope: scope as PolicyScope,
  };
  if (decision !== undefined) {
    out.decision = decision as Exclude<PolicyRule['decision'], undefined>;
  }
  if (notes !== undefined) {
    out.notes = notes;
  }
  if (validatedWhen !== undefined) {
    out.when = validatedWhen;
  }
  return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
