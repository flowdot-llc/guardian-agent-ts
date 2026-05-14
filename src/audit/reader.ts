/**
 * AuditLogReader — iterate + verify hash chain. SPEC §2.
 */

import { open, FileHandle } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface, Interface } from 'node:readline';
import type { KeyObject } from 'node:crypto';

import type { AuditRecord } from '../types.js';
import { GuardianIntegrityError } from '../errors.js';
import { GENESIS_HASH, computeRecordHash } from './chain.js';
import { verifyRecord } from './signature.js';

export class AuditLogReader {
  readonly path: string;

  private handle: FileHandle | null = null;

  private constructor(path: string) {
    this.path = path;
  }

  static async open(path: string): Promise<AuditLogReader> {
    const reader = new AuditLogReader(path);
    reader.handle = await open(path, 'r');
    return reader;
  }

  /** Async-iterate over all records. Each call returns a fresh iterator. */
  async *records(): AsyncGenerator<AuditRecord, void, void> {
    const lines = this.openLineStream();
    try {
      for await (const line of lines) {
        if (line.length === 0) continue;
        yield JSON.parse(line) as AuditRecord;
      }
    } finally {
      lines.close();
    }
  }

  /**
   * Verify every record's ed25519 signature against the given public key.
   * Throws GuardianIntegrityError on the first record with a missing or
   * invalid signature. Returns the count of records verified.
   *
   * SPEC §2.6.
   */
  async verifySignatures(publicKey: KeyObject): Promise<number> {
    let count = 0;
    for await (const record of this.records()) {
      if (record.signature == null) {
        throw new GuardianIntegrityError(
          `audit log record ${count + 1} has no signature`,
        );
      }
      if (!verifyRecord(record, publicKey)) {
        throw new GuardianIntegrityError(
          `audit log signature verification failed at record ${count + 1}`,
          `event_id=${record.event_id}`,
        );
      }
      count++;
    }
    return count;
  }

  /**
   * Verify the full hash chain. Throws GuardianIntegrityError on first break.
   * Returns the count of records verified on success.
   */
  async verifyChain(): Promise<number> {
    let expectedPrev = GENESIS_HASH;
    let count = 0;
    for await (const record of this.records()) {
      if (record.prev_hash !== expectedPrev) {
        throw new GuardianIntegrityError(
          `audit log hash chain broken at record ${count + 1}`,
          `expected prev_hash=${expectedPrev}, got ${record.prev_hash}`,
        );
      }
      expectedPrev = computeRecordHash(record);
      count++;
    }
    return count;
  }

  /** Idempotent close. */
  async close(): Promise<void> {
    if (this.handle) {
      await this.handle.close();
      this.handle = null;
    }
  }

  // ---- internal --------------------------------------------------------------

  private openLineStream(): Interface {
    // We open a fresh read stream for each iteration so consumers can re-iterate.
    const stream = createReadStream(this.path, { encoding: 'utf-8' });
    return createInterface({ input: stream, crlfDelay: Infinity });
  }
}
