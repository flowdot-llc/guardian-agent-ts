/**
 * SiteKey — 32 random bytes used as the HMAC key for policy file integrity.
 *
 * Generated on first run; persisted under `.guardian/site.key` (or whatever
 * directory the consumer points us at). Mode 0o600. Never logged.
 *
 * SPEC §3.5.
 */

import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';

import { GuardianConfigError } from '../errors.js';

const SITE_KEY_BYTES = 32;

export interface SiteKey {
  bytes: Buffer;
  path: string;
}

/**
 * Load the site key from `path`, or generate and persist a new one if absent.
 * Throws if the file exists but has the wrong length.
 *
 * Creation is EXCLUSIVE (`wx`). Several processes can share one policy
 * directory — the CLI, its agent-job workers, the desktop app — and a
 * check-then-write let two of them starting together each generate a key and
 * the second overwrite the first. Whichever process then held the losing key
 * failed HMAC verification on every read, i.e. a `GuardianIntegrityError` on
 * every policy evaluation. On `EEXIST` the winner's key is read instead.
 */
export function loadOrCreateSiteKey(path: string): SiteKey {
  const existing = readExistingSiteKey(path);
  if (existing) return { bytes: existing, path };

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const bytes = randomBytes(SITE_KEY_BYTES);
  try {
    writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    // Another process won the race; its key is the one on disk.
    const winner = readExistingSiteKey(path);
    if (!winner) {
      throw new GuardianConfigError(`site key at ${path} vanished while being created`);
    }
    return { bytes: winner, path };
  }
  // Re-chmod in case umask suppressed it.
  /* c8 ignore start */
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows: mode bits may not be enforceable. Best-effort.
  }
  /* c8 ignore stop */
  return { bytes, path };
}

/** Read an existing key, validating its length. Returns null when absent. */
function readExistingSiteKey(path: string): Buffer | null {
  if (!existsSync(path)) return null;
  const bytes = readFileSync(path);
  if (bytes.length !== SITE_KEY_BYTES) {
    throw new GuardianConfigError(
      `site key at ${path} is ${bytes.length} bytes, expected ${SITE_KEY_BYTES}`,
    );
  }
  return bytes;
}

/** Build a SiteKey from raw bytes (for testing). */
export function siteKeyFromBytes(bytes: Buffer): SiteKey {
  if (bytes.length !== SITE_KEY_BYTES) {
    throw new GuardianConfigError(
      `site key bytes are ${bytes.length}, expected ${SITE_KEY_BYTES}`,
    );
  }
  return { bytes, path: '<in-memory>' };
}

export { SITE_KEY_BYTES };
