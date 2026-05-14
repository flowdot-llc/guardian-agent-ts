/**
 * External chain attestation. SPEC §2.7 (v0.3.0+).
 *
 * Why this exists: the local audit log is hash-chained + ed25519-signed, but
 * the writer's signing key lives on the same machine as the writer. If the
 * runtime is fully compromised, an attacker can sign a fabricated chain just
 * as easily as the legitimate writer. Attestation closes that gap by
 * periodically publishing the current chain head + its signature to an
 * external append-only store the local process cannot rewrite. A later
 * verifier can cross-check the local chain against the external receipts;
 * any divergence indicates tamper.
 *
 * The library defines the `Attestor` interface + a reference HTTP adapter.
 * Production deployments may use S3 with object-lock + versioning, a
 * Sigstore Rekor transparency log, or a second-party receiver. Library
 * never assumes a specific backend.
 *
 * Failure mode: attestor errors are NEVER fatal. A failed attestation is
 * itself an audit row (`x_chain_attestation_failed`). The supervisor
 * continues. An adversary who can DoS the attestation endpoint cannot use
 * that to halt the agent's session.
 */

import type { AuditRecord } from '../types.js';

/**
 * Payload sent to the attestor for one attestation event. The `head` is the
 * hash of the most-recently-appended record (NOT a synthesized commitment).
 * `signature` is the signature of that record. `recordCount` is the total
 * number of records appended to the chain in this session up to and
 * including the head record.
 */
export interface AttestationPayload {
  /** Agent id, mirrors the audit record's `agent_id`. */
  agentId: string;
  /** Session id, mirrors the audit record's `session_id`. */
  sessionId: string;
  /** `sha256:<hex>` of the canonical-JSON of the head record. */
  head: string;
  /** Head record's `ed25519:<base64url>` signature (when signing is enabled). */
  signature: string | null;
  /** Total records appended in this session through the head. */
  recordCount: number;
  /** ISO-8601 timestamp at which the attestation was emitted. */
  ts: string;
  /** Schema version of the payload itself; bumped on incompatible changes. */
  v: '1';
}

/**
 * Receipt the attestor MAY return. When provided, the receipt id is recorded
 * on the local `x_chain_attested` audit row, letting verifiers correlate
 * external receipts with local chain heads.
 */
export interface AttestationReceipt {
  /** Attestor-assigned id (URL fragment, Rekor log index, S3 version id...). */
  receiptId: string;
  /** Optional URL where the receipt can be inspected. */
  url?: string;
}

/**
 * The contract a consumer implements (or wires from a reference adapter).
 * One method, takes a payload, returns a receipt or throws.
 */
export interface Attestor {
  /**
   * Publish an attestation. Implementations MUST NOT mutate `payload`.
   * Implementations MAY return synchronously or asynchronously.
   *
   * Throwing here is an expected failure mode; callers (AuditLogWriter)
   * catch and convert to `x_chain_attestation_failed` audit rows.
   */
  publish(payload: AttestationPayload): Promise<AttestationReceipt> | AttestationReceipt;
}

// ============================================================================
// httpAttestor — reference HTTP adapter
// ============================================================================

export interface HttpAttestorOptions {
  /** Endpoint URL. The attestor POSTs the JSON payload here. */
  url: string;
  /** Optional headers (auth bearer, content-type override, etc.). */
  headers?: Record<string, string>;
  /** Request timeout in ms. Default 5000. */
  timeoutMs?: number;
  /** Optional fetch implementation override (testing). */
  fetchImpl?: typeof fetch;
}

/**
 * Reference HTTP attestor: POSTs the payload as JSON, expects a JSON
 * `{ receiptId, url? }` response. 2xx → success; anything else → throws.
 *
 * This adapter is INTENTIONALLY MINIMAL. Production deployments will want
 * retries, auth refresh, content-addressed bodies, etc. — those belong in
 * the consumer's adapter, not the library.
 */
export function httpAttestor(options: HttpAttestorOptions): Attestor {
  const url = options.url;
  const headers = options.headers ?? {};
  const timeoutMs = options.timeoutMs ?? 5000;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error('httpAttestor: global fetch is not available; supply fetchImpl');
  }
  return {
    async publish(payload: AttestationPayload): Promise<AttestationReceipt> {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`httpAttestor: ${res.status} ${res.statusText}`);
        }
        const body = (await res.json()) as Partial<AttestationReceipt>;
        if (!body.receiptId || typeof body.receiptId !== 'string') {
          throw new Error('httpAttestor: response missing receiptId');
        }
        const r: AttestationReceipt = { receiptId: body.receiptId };
        if (typeof body.url === 'string') r.url = body.url;
        return r;
      } finally {
        clearTimeout(t);
      }
    },
  };
}

// ============================================================================
// nullAttestor — for tests and explicit-disable scenarios
// ============================================================================

/**
 * No-op attestor that returns synthetic receipts. Use in tests, or when a
 * consumer wants the supervisor to log `x_chain_attested` rows for audit
 * shape parity without actually publishing externally.
 */
export function nullAttestor(): Attestor {
  let n = 0;
  return {
    publish(): AttestationReceipt {
      n += 1;
      return { receiptId: `null-${n}` };
    },
  };
}

// ============================================================================
// Helper: build a payload from a record + count.
// ============================================================================

/**
 * Build the canonical payload from a head record + the running record count.
 * Pure: same inputs → same payload. Exposed for tests.
 */
export function payloadFromRecord(
  record: AuditRecord,
  recordCount: number,
  headHash: string,
): AttestationPayload {
  return {
    agentId: record.agent_id,
    sessionId: record.session_id,
    head: headHash,
    signature: record.signature ?? null,
    recordCount,
    ts: new Date().toISOString(),
    v: '1',
  };
}
