/**
 * guardian-verify — log integrity verification CLI. SPEC §2.5, §2.6.
 *
 * Usage:
 *   guardian-verify <audit.jsonl>                    # verify hash chain
 *   guardian-verify <audit.jsonl> --pubkey <pem>     # verify hash chain + signatures
 *
 * Exit codes:
 *   0 — all verifications passed
 *   1 — hash chain broken / signature invalid / IO error
 *   2 — usage error (bad args)
 */

import { readFileSync } from 'node:fs';

import { AuditLogReader } from '../audit/reader.js';
import { loadPublicKey } from '../audit/signature.js';
import { GuardianIntegrityError } from '../errors.js';

export interface VerifyResult {
  recordCount: number;
  chainVerified: boolean;
  signaturesVerified: boolean;
  exitCode: 0 | 1 | 2;
  message: string;
}

export interface VerifyArgs {
  path: string | undefined;
  pubkeyPath: string | undefined;
}

/** Parse argv. Returns the parsed args or null on usage error. */
export function parseArgs(argv: readonly string[]): VerifyArgs | null {
  const args = argv.slice();
  let path: string | undefined;
  let pubkeyPath: string | undefined;

  while (args.length > 0) {
    const a = args.shift();
    /* c8 ignore next */
    if (a === undefined) break;
    if (a === '--pubkey') {
      const next = args.shift();
      if (next === undefined) return null;
      pubkeyPath = next;
    } else if (a === '--help' || a === '-h') {
      return { path: undefined, pubkeyPath: undefined };
    } else if (a.startsWith('--')) {
      return null;
    } else {
      if (path !== undefined) return null; // only one positional accepted
      path = a;
    }
  }

  return { path, pubkeyPath };
}

/** Run a verification given parsed args. */
export async function runVerify(args: VerifyArgs): Promise<VerifyResult> {
  if (!args.path) {
    return {
      recordCount: 0,
      chainVerified: false,
      signaturesVerified: false,
      exitCode: 2,
      message: usageString(),
    };
  }

  const reader = await AuditLogReader.open(args.path);
  try {
    let chainCount = 0;
    try {
      chainCount = await reader.verifyChain();
    } catch (err) {
      /* c8 ignore next */
      const msg = err instanceof GuardianIntegrityError ? err.message : String(err);
      return {
        recordCount: 0,
        chainVerified: false,
        signaturesVerified: false,
        exitCode: 1,
        message: `chain verification failed: ${msg}`,
      };
    }

    let signaturesVerified = false;
    if (args.pubkeyPath) {
      const pem = readFileSync(args.pubkeyPath, 'utf-8');
      const pubkey = loadPublicKey(pem);
      try {
        await reader.verifySignatures(pubkey);
        signaturesVerified = true;
      } catch (err) {
        /* c8 ignore next */
      const msg = err instanceof GuardianIntegrityError ? err.message : String(err);
        return {
          recordCount: chainCount,
          chainVerified: true,
          signaturesVerified: false,
          exitCode: 1,
          message: `signature verification failed: ${msg}`,
        };
      }
    }

    const parts = [`chain ok (${chainCount} records)`];
    if (signaturesVerified) parts.push('signatures ok');
    return {
      recordCount: chainCount,
      chainVerified: true,
      signaturesVerified,
      exitCode: 0,
      message: parts.join('; '),
    };
  } finally {
    await reader.close();
  }
}

export function usageString(): string {
  return [
    'guardian-verify — verify guardian-agent audit log integrity',
    '',
    'Usage:',
    '  guardian-verify <audit.jsonl> [--pubkey <pem>]',
    '',
    'Options:',
    '  --pubkey <pem>   Path to an ed25519 public key (PEM). When supplied, signatures are verified.',
    '  --help, -h       Show this message.',
  ].join('\n');
}
