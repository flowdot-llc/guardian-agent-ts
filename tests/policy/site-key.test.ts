import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

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

describe('loadOrCreateSiteKey — exclusive creation', () => {
  it("returns the winner's key when another process creates it first (EEXIST)", async () => {
    const path = join(tmp, 'site.key');
    const rival = Buffer.alloc(SITE_KEY_BYTES, 9);

    // Simulate the real race: the exclusive create fails with EEXIST because a
    // second process wrote the key between our existsSync check and our write.
    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      let firstExclusiveWrite = true;
      return {
        ...actual,
        writeFileSync: ((target: string, data: unknown, options?: { flag?: string }) => {
          if (firstExclusiveWrite && options?.flag === 'wx') {
            firstExclusiveWrite = false;
            actual.writeFileSync(target, rival);
            const err = new Error('EEXIST: file already exists') as NodeJS.ErrnoException;
            err.code = 'EEXIST';
            throw err;
          }
          return actual.writeFileSync(target, data as never, options as never);
        }) as typeof actual.writeFileSync,
      };
    });

    try {
      const mod = await import('../../src/policy/site-key.js');
      const key = mod.loadOrCreateSiteKey(path);
      expect(key.bytes.equals(rival)).toBe(true);
      expect(readFileSync(path).equals(rival)).toBe(true);
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });

  it('two sequential loads in one directory agree on one key', () => {
    const path = join(tmp, 'site.key');
    const a = loadOrCreateSiteKey(path);
    const b = loadOrCreateSiteKey(path);
    expect(a.bytes.equals(b.bytes)).toBe(true);
  });
});
