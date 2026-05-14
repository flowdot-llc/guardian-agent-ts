import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  loadOrCreateSiteKey,
  siteKeyFromBytes,
  SITE_KEY_BYTES,
} from '../../src/policy/site-key.js';
import { GuardianConfigError } from '../../src/errors.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'guardian-sitekey-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('loadOrCreateSiteKey', () => {
  it('generates a new key when none exists', async () => {
    const path = join(tmp, 'site.key');
    const k = loadOrCreateSiteKey(path);
    expect(k.bytes.length).toBe(SITE_KEY_BYTES);
    expect(k.path).toBe(path);
    const persisted = await readFile(path);
    expect(persisted.equals(k.bytes)).toBe(true);
  });

  it('loads an existing key', () => {
    const path = join(tmp, 'site.key');
    const first = loadOrCreateSiteKey(path);
    const second = loadOrCreateSiteKey(path);
    expect(second.bytes.equals(first.bytes)).toBe(true);
  });

  it('throws on wrong-length key file', async () => {
    const path = join(tmp, 'site.key');
    await writeFile(path, Buffer.from('short'));
    expect(() => loadOrCreateSiteKey(path)).toThrow(GuardianConfigError);
  });

  it('creates parent directory if missing', () => {
    const path = join(tmp, 'nested', 'deeper', 'site.key');
    const k = loadOrCreateSiteKey(path);
    expect(k.bytes.length).toBe(SITE_KEY_BYTES);
  });
});

describe('siteKeyFromBytes', () => {
  it('accepts 32 bytes', () => {
    const k = siteKeyFromBytes(Buffer.alloc(32, 7));
    expect(k.bytes.length).toBe(32);
  });

  it('rejects wrong-length bytes', () => {
    expect(() => siteKeyFromBytes(Buffer.alloc(16))).toThrow(GuardianConfigError);
  });
});
