/**
 * Single-writer append-only JSONL audit log with hash chain. SPEC §2.
 */

import { open, FileHandle } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import type { KeyObject } from 'node:crypto';
import { ulid } from 'ulidx';

import type {
  AuditRecord,
  AuditRecordInput,
} from '../types.js';
import { SPEC_VERSION } from '../types.js';
import { GENESIS_HASH, computeRecordHash, canonicalJsonStringify } from './chain.js';
import { signRecord } from './signature.js';
import type { Attestor } from './attestor.js';
import { payloadFromRecord } from './attestor.js';

export interface AuditLogWriterOptions {
  /** Path to the JSONL audit log file. Created if absent. */
  path: string;
  /** Agent id stamped onto every record. */
  agentId: string;
  /** Session id stamped onto every record. */
  sessionId: string;
  /** File permission mode. Defaults to 0o600. */
  fileMode?: number;
  /** ed25519 private key. When set, every record is signed. SPEC §2.6 (v0.5+). */
  signWith?: KeyObject;
  /**
   * Called once on open() when an existing log is reopened. Fires with the
   * last record so the host can detect unclean shutdown (last record was
   * anything other than session_close).
   *
   * Not called on a fresh file (no existing tip). Errors thrown inside the
   * callback do not prevent the writer from opening — they propagate to the
   * caller of open().
   */
  onTipRecovered?: (lastRecord: AuditRecord) => void | Promise<void>;
  /**
   * External attestor. When set, the writer publishes the current chain
   * head every {@link attestEvery} records and on close(). Each successful
   * publish emits an `x_chain_attested` audit row; failures emit
   * `x_chain_attestation_failed`. Attestor errors are NEVER fatal. SPEC §2.7.
   */
  attestor?: Attestor;
  /** Records between attestations. Default 100. Ignored when attestor is unset. */
  attestEvery?: number;
  /**
   * Attest the final chain head when close() is called. Default true.
   * Ignored when attestor is unset.
   */
  attestOnClose?: boolean;
}

/**
 * Append-only writer. Internal queue ensures the hash chain is strictly
 * ordered even when callers `append` concurrently.
 */
export class AuditLogWriter {
  readonly path: string;
  readonly agentId: string;
  readonly sessionId: string;

  private fileMode: number;
  private handle: FileHandle | null = null;
  private openPromise: Promise<void> | null = null;
  private closed = false;
  private _tipHash: string = GENESIS_HASH;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly signWith: KeyObject | undefined;
  private readonly onTipRecovered:
    | ((lastRecord: AuditRecord) => void | Promise<void>)
    | undefined;
  private readonly attestor: Attestor | undefined;
  private readonly attestEvery: number;
  private readonly attestOnClose: boolean;
  // Running count of records appended in THIS process. Reset to 0 on open()
  // and incremented on each writeOne. Used to fire attestation at fixed
  // intervals.
  private appendedCount = 0;
  // Set true while emitting an attestation-related audit row, so the
  // attestation hook does NOT re-trigger on its own audit rows. Prevents
  // unbounded recursion: an attestation row would otherwise be the next
  // record to attest.
  private attestationInFlight = false;

  constructor(options: AuditLogWriterOptions) {
    this.path = options.path;
    this.agentId = options.agentId;
    this.sessionId = options.sessionId;
    this.fileMode = options.fileMode ?? 0o600;
    this.signWith = options.signWith;
    this.onTipRecovered = options.onTipRecovered;
    this.attestor = options.attestor;
    this.attestEvery = options.attestEvery ?? 100;
    this.attestOnClose = options.attestOnClose ?? true;
    if (this.attestEvery <= 0) {
      throw new Error('attestEvery must be > 0');
    }
  }

  /** Tip of the hash chain (the last appended record's hash). */
  get tipHash(): string {
    return this._tipHash;
  }

  /** Open the underlying file (idempotent + single-flight). Recovers tip hash if file exists. */
  async open(): Promise<void> {
    if (this.openPromise) return this.openPromise;
    this.openPromise = (async () => {
      let recoveredTip: AuditRecord | null = null;
      if (existsSync(this.path)) {
        const recovered = await this.recoverTipRecord();
        if (recovered !== null) {
          this._tipHash = computeRecordHash(recovered);
          recoveredTip = recovered;
        }
      }
      // Open for append; create if absent. Mode applies on creation only.
      this.handle = await open(this.path, 'a', this.fileMode);
      // Fire the recovery callback AFTER the handle is open so the callback
      // can use append() if it wants to record a session_recovered event.
      if (recoveredTip !== null && this.onTipRecovered) {
        await this.onTipRecovered(recoveredTip);
      }
    })();
    return this.openPromise;
  }

  /** Append a record. Computes hash chain; serializes via internal queue. */
  async append(input: AuditRecordInput): Promise<AuditRecord> {
    if (this.closed) {
      throw new Error('AuditLogWriter is closed');
    }
    // Serialize via the queue: each append waits on the previous one. We chain
    // the open() into the queue so concurrent first-appends do not race.
    const result = this.queue.then(async () => {
      await this.open();
      return this.writeOne(input);
    });
    // Replace the queue with a swallowed-error version so one failure doesn't
    // poison subsequent appends.
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** Flush and close the file handle. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    // Final attestation BEFORE flipping `closed`, so we can still append.
    if (this.attestor && this.attestOnClose && this.appendedCount > 0) {
      await this.runAttestation();
    }
    this.closed = true;
    // Drain the queue.
    /* c8 ignore start */
    try {
      await this.queue;
    } catch {
      // Defensive: queue is always re-wrapped with .catch(() => undefined)
      // in append(), so this catch is structurally unreachable. Kept as
      // belt-and-braces against future refactors.
    }
    /* c8 ignore stop */
    if (this.handle) {
      await this.handle.close();
      this.handle = null;
    }
  }

  /**
   * Publish the current chain head to the configured attestor and emit
   * `x_chain_attested` (success) or `x_chain_attestation_failed` (error).
   * Idempotent on no-attestor or in-flight: callers can fire-and-forget.
   *
   * Exposed publicly so consumers can force a flush (e.g., on a
   * manually-triggered checkpoint).
   */
  async runAttestation(): Promise<void> {
    if (!this.attestor || this.attestationInFlight || this.closed) return;
    this.attestationInFlight = true;
    try {
      // Build the payload from the most-recently-written record's hash. We
      // synthesize a minimal AuditRecord wrapper for payloadFromRecord:
      // only fields it reads are agent_id/session_id/signature, and we
      // already have all three.
      const head = this._tipHash;
      // The last record's signature isn't trivially recoverable without
      // re-reading the file; we publish with `signature: null` and let the
      // verifier cross-check against the chain head only. The chain head is
      // the load-bearing commitment; the signature is an auxiliary check
      // that the verifier can run independently against the local log.
      const synthRecord = {
        agent_id: this.agentId,
        session_id: this.sessionId,
        signature: null,
      } as unknown as AuditRecord;
      const payload = payloadFromRecord(synthRecord, this.appendedCount, head);
      try {
        const receipt = await this.attestor.publish(payload);
        await this.appendInternal({
          kind: 'x_chain_attested' as unknown as 'session_open',
          status: 'approved',
          initiator: 'system',
          detail: {
            chain_head: head,
            records_in_session: this.appendedCount,
            receipt_id: receipt.receiptId,
            ...(receipt.url ? { receipt_url: receipt.url } : {}),
          },
        });
      } catch (err) {
        await this.appendInternal({
          kind: 'x_chain_attestation_failed' as unknown as 'session_open',
          status: 'errored',
          initiator: 'system',
          detail: {
            chain_head: head,
            records_in_session: this.appendedCount,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
    } finally {
      this.attestationInFlight = false;
    }
  }

  /**
   * Internal-only append that bypasses the closed check (used by close() to
   * write the final attestation row) and skips the attestation hook (to
   * avoid recursion when writing attestation outcome rows).
   */
  private async appendInternal(input: AuditRecordInput): Promise<AuditRecord> {
    const result = this.queue.then(async () => {
      await this.open();
      return this.writeOne(input);
    });
    this.queue = result.catch(() => undefined);
    return result;
  }

  // ---- internal --------------------------------------------------------------

  private async writeOne(input: AuditRecordInput): Promise<AuditRecord> {
    /* c8 ignore start */
    if (!this.handle) {
      throw new Error('AuditLogWriter not open');
    }
    /* c8 ignore stop */

    const record: AuditRecord = {
      v: SPEC_VERSION,
      event_id: 'evt_' + ulid(),
      ts: new Date().toISOString(),
      agent_id: input.agentId ?? this.agentId,
      session_id: input.sessionId ?? this.sessionId,
      kind: input.kind,
      status: input.status,
      initiator: input.initiator,
      prev_hash: this._tipHash,
      ...(input.tool === undefined ? {} : { tool: input.tool }),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.detail === undefined ? {} : { detail: input.detail }),
    };

    // Sign or write `signature: null` per SPEC §2.6.
    record.signature = null;
    if (this.signWith) {
      record.signature = signRecord(record, this.signWith);
    }

    const line = canonicalJsonStringify(record) + '\n';
    await this.handle.write(line);
    // Best-effort fsync. Errors here are not fatal; the OS will get to it.
    try {
      await this.handle.sync();
    } catch {
      // Some platforms / filesystems disallow fsync; ignore.
    }

    this._tipHash = computeRecordHash(record);
    this.appendedCount += 1;

    // Fire attestation when we cross an attestEvery boundary. Skip if this
    // append IS itself an attestation outcome row (set by runAttestation).
    if (
      this.attestor &&
      !this.attestationInFlight &&
      this.appendedCount % this.attestEvery === 0
    ) {
      // Fire-and-forget: failures are recorded as audit rows by
      // runAttestation itself. We don't await here so a slow attestor
      // doesn't back up the writer queue. The internal queue still
      // serializes the audit row writes.
      void this.runAttestation();
    }

    return record;
  }

  /**
   * Read the last non-empty record from the existing log. Returns null when
   * the file is empty or contains only blank lines. Used during open() to
   * seed the hash chain and expose the recovered record to onTipRecovered.
   */
  private async recoverTipRecord(): Promise<AuditRecord | null> {
    const buf = readFileSync(this.path, 'utf-8');
    if (buf.length === 0) return null;
    const lines = buf.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line === undefined || line.length === 0) continue;
      return JSON.parse(line) as AuditRecord;
    }
    return null;
  }
}
