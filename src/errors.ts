/**
 * Public error types.
 */

/**
 * Thrown inside a tool wrapper when the runtime is halted.
 * SPEC §5.2.
 */
export class GuardianHaltedError extends Error {
  readonly reason: string | undefined;
  readonly operatorId: string | undefined;

  constructor(message: string, reason?: string, operatorId?: string) {
    super(message);
    this.name = 'GuardianHaltedError';
    this.reason = reason;
    this.operatorId = operatorId;
  }
}

/**
 * Thrown for invalid configuration: malformed policy YAML, missing required
 * options, contradictory rules, etc.
 */
export class GuardianConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuardianConfigError';
  }
}

/**
 * Thrown when integrity verification fails: a broken audit-log hash chain,
 * a failed HMAC on a policy file, or a bad ed25519 signature.
 */
export class GuardianIntegrityError extends Error {
  readonly detail: string | undefined;

  constructor(message: string, detail?: string) {
    super(message);
    this.name = 'GuardianIntegrityError';
    this.detail = detail;
  }
}

/**
 * Thrown inside a tool wrapper when the configured policy gate denies the
 * call (either a `deny` rule matched, or operator confirmation came back
 * denied/timed out from a `prompt` decision). v0.2.0+.
 *
 * Distinct from {@link GuardianHaltedError}: a policy denial is per-call
 * (next call may be allowed by a different rule, or after a re-prompt), and
 * does NOT press the local E-stop. An E-stop denial throws
 * `GuardianHaltedError` instead.
 */
export class PolicyDenialError extends Error {
  readonly category: string;
  readonly identifier: string;
  readonly policyIdentifier: string;
  readonly scope: string;
  readonly ruleTool: string | undefined;

  constructor(
    message: string,
    detail: {
      category: string;
      identifier: string;
      policyIdentifier: string;
      scope: string;
      ruleTool?: string;
    },
  ) {
    super(message);
    this.name = 'PolicyDenialError';
    this.category = detail.category;
    this.identifier = detail.identifier;
    this.policyIdentifier = detail.policyIdentifier;
    this.scope = detail.scope;
    this.ruleTool = detail.ruleTool;
  }
}
