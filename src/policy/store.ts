/**
 * PolicyStore — HMAC-signed permissions.yaml + unsigned session.yaml.
 * SPEC §3.1 / §3.5 / §3.6.
 *
 * Pre-alpha: simple sync I/O strategy + per-store async queue to serialize
 * writes. Cross-process locking via `proper-lockfile` is planned for v0.4+;
 * for now, the library assumes a single process per `.guardian/` directory.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
  unlinkSync,
  statSync,
} from 'node:fs';
import { randomFillSync } from 'node:crypto';
import { join } from 'node:path';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { GuardianIntegrityError } from '../errors.js';
import type { Policy, PolicyRule, PolicyScope } from './types.js';
import { validatePolicy } from './loader.js';
import { signPayload, verifyPayload, type SignedPolicyFile } from './integrity.js';
import { loadOrCreateSiteKey, type SiteKey } from './site-key.js';

export interface PolicyStoreOptions {
  /** Directory holding permissions.yaml, session.yaml, site.key. */
  dir: string;
  /** Agent id this store is for. */
  agentId: string;
  /** Default behavior when no rule matches. Used to seed an empty store. */
  defaultScope?: 'prompt' | PolicyScope;
  /** Pre-supplied site key (testing). If absent, loaded or created at `dir/site.key`. */
  siteKey?: SiteKey;
}

const PERMISSIONS_FILE = 'permissions.yaml';
const SESSION_FILE = 'session.yaml';
const SITE_KEY_FILE = 'site.key';
const POLICY_FILE_VERSION = 1 as const;

export class PolicyStore {
  readonly dir: string;
  readonly agentId: string;
  private readonly siteKey: SiteKey;
  private readonly defaultScope: 'prompt' | PolicyScope;

  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(options: PolicyStoreOptions) {
    this.dir = options.dir;
    this.agentId = options.agentId;
    this.defaultScope = options.defaultScope ?? 'prompt';
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.siteKey = options.siteKey ?? loadOrCreateSiteKey(join(this.dir, SITE_KEY_FILE));
  }

  /** Read merged policy: persistent rules + session rules. */
  getPolicy(): Policy {
    const persistent = this.readPersistent();
    const session = this.readSession();
    return {
      version: persistent.version,
      agent_id: this.agentId,
      defaults: persistent.defaults,
      rules: [...persistent.rules, ...session.rules],
    };
  }

  /** Add a rule. session/once go to session.yaml; forever/banned go to permissions.yaml. */
  addRule(rule: PolicyRule): Promise<void> {
    return this.enqueue(() => {
      if (rule.scope === 'session' || rule.scope === 'once') {
        const cur = this.readSession();
        cur.rules = [
          ...cur.rules.filter((r) => !(r.tool === rule.tool && r.scope === rule.scope)),
          rule,
        ];
        this.writeSession(cur);
      } else {
        const cur = this.readPersistent();
        cur.rules = [
          ...cur.rules.filter((r) => !(r.tool === rule.tool && r.scope === rule.scope)),
          rule,
        ];
        this.writePersistent(cur);
      }
    });
  }

  /** Remove a rule by tool + scope. No-op if absent. */
  removeRule(tool: string, scope: PolicyScope): Promise<void> {
    return this.enqueue(() => {
      if (scope === 'session' || scope === 'once') {
        const cur = this.readSession();
        cur.rules = cur.rules.filter((r) => !(r.tool === tool && r.scope === scope));
        this.writeSession(cur);
      } else {
        const cur = this.readPersistent();
        cur.rules = cur.rules.filter((r) => !(r.tool === tool && r.scope === scope));
        this.writePersistent(cur);
      }
    });
  }

  /** Drop session rules. */
  clearSession(): Promise<void> {
    return this.enqueue(() => {
      const sessionPath = join(this.dir, SESSION_FILE);
      if (existsSync(sessionPath)) {
        secureUnlink(sessionPath);
      }
    });
  }

  /** Idempotent close. */
  async close(): Promise<void> {
    /* c8 ignore start */
    try {
      await this.writeQueue;
    } catch {
      // Defensive: enqueue() re-wraps with .catch(() => undefined), so
      // writeQueue never actually rejects. Belt-and-braces.
    }
    /* c8 ignore stop */
  }

  // ---- internal --------------------------------------------------------------

  private enqueue<T>(fn: () => T): Promise<T> {
    const result = this.writeQueue.then(() => fn());
    this.writeQueue = result.catch(() => undefined);
    return result;
  }

  private emptyPolicy(): Policy {
    return {
      version: '0.2',
      agent_id: this.agentId,
      defaults: { scope: this.defaultScope },
      rules: [],
    };
  }

  private readPersistent(): Policy {
    const path = join(this.dir, PERMISSIONS_FILE);
    if (!existsSync(path)) {
      return this.emptyPolicy();
    }
    const raw = readFileSync(path, 'utf-8');
    const signed = parseYaml(raw) as unknown;
    if (!isSignedFile(signed)) {
      throw new GuardianIntegrityError(
        `permissions.yaml at ${path} is not in signed-file format`,
      );
    }
    if (!verifyPayload(signed.data, signed.signature, this.siteKey.bytes)) {
      throw new GuardianIntegrityError(
        `permissions.yaml at ${path} failed HMAC verification`,
      );
    }
    const data = parseYaml(signed.data) as unknown;
    return validatePolicy(data);
  }

  private writePersistent(policy: Policy): void {
    const path = join(this.dir, PERMISSIONS_FILE);
    const payload: Record<string, unknown> = {
      version: policy.version,
      agent_id: this.agentId,
      defaults: policy.defaults as unknown as Record<string, unknown>,
      rules: policy.rules,
    };
    const dataStr = stringifyYaml(payload, { sortMapEntries: true });
    const signature = signPayload(dataStr, this.siteKey.bytes);
    const file: SignedPolicyFile = {
      version: POLICY_FILE_VERSION,
      signed_at: new Date().toISOString(),
      signature,
      data: dataStr,
    };
    writeFileSync(path, stringifyYaml(file), { mode: 0o600 });
    /* c8 ignore start */
    try {
      chmodSync(path, 0o600);
    } catch {
      // Windows / mode-bit unsupported FS — best effort.
    }
    /* c8 ignore stop */
  }

  private readSession(): Policy {
    const path = join(this.dir, SESSION_FILE);
    if (!existsSync(path)) {
      return this.emptyPolicy();
    }
    const raw = readFileSync(path, 'utf-8');
    if (raw.length === 0) return this.emptyPolicy();
    const parsed = parseYaml(raw) as unknown;
    return validatePolicy(parsed);
  }

  private writeSession(policy: Policy): void {
    const path = join(this.dir, SESSION_FILE);
    const payload = {
      version: policy.version,
      agent_id: this.agentId,
      defaults: policy.defaults,
      rules: policy.rules,
    };
    writeFileSync(path, stringifyYaml(payload, { sortMapEntries: true }), { mode: 0o600 });
    /* c8 ignore start */
    try {
      chmodSync(path, 0o600);
    } catch {
      // ignore
    }
    /* c8 ignore stop */
  }
}

function isSignedFile(v: unknown): v is SignedPolicyFile {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    obj.version === POLICY_FILE_VERSION &&
    typeof obj.signed_at === 'string' &&
    typeof obj.signature === 'string' &&
    typeof obj.data === 'string'
  );
}

/* c8 ignore start — defensive secure-delete helper: stat / write / unlink
   failure modes are platform-specific (Windows file locks, EACCES on read-only
   mounts). Catches preserved as best-effort. */
function secureUnlink(path: string): void {
  try {
    const stat = statSync(path);
    const len = stat.size;
    if (len > 0) {
      const buf = Buffer.alloc(len);
      for (let i = 0; i < 3; i++) {
        randomFillSync(buf);
        writeFileSync(path, buf);
      }
    }
  } catch {
    // ignore — best-effort
  }
  try {
    unlinkSync(path);
  } catch {
    // ignore
  }
}
/* c8 ignore stop */
