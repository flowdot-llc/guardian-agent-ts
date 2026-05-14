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
 */
export function loadOrCreateSiteKey(path: string): SiteKey {
  if (existsSync(path)) {
    const bytes = readFileSync(path);
    if (bytes.length !== SITE_KEY_BYTES) {
      throw new GuardianConfigError(
        `site key at ${path} is ${bytes.length} bytes, expected ${SITE_KEY_BYTES}`,
      );
    }
    return { bytes, path };
  }

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const bytes = randomBytes(SITE_KEY_BYTES);
  writeFileSync(path, bytes, { mode: 0o600 });
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
