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
