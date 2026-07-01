#!/usr/bin/env node
/**
 * verify-pack.mjs — hard gate that inspects `npm pack --dry-run --json`
 * and fails the publish if forbidden files appear in the tarball.
 *
 * Forbidden patterns are defined in FORBIDDEN_PATTERNS below. The gate also
 * asserts that LICENSE and README.md are present.
 *
 * This script is invoked by `prepublishOnly` and CI — not meant to be skipped.
 */

import { execSync } from 'node:child_process';
import process from 'node:process';

const FORBIDDEN_PATTERNS = [
  { pattern: /\.ts$/, reason: 'TypeScript source', except: /\.d\.ts$/ },
  { pattern: /\.tsx$/, reason: 'TypeScript JSX source' },
  { pattern: /\.map$/, reason: 'Source map (leaks paths/content)' },
  { pattern: /(^|\/)src\//, reason: 'Source directory' },
  { pattern: /(^|\/)tsconfig.*\.json$/, reason: 'TypeScript build config' },
  { pattern: /(^|\/)vitest\.config\./, reason: 'Vitest config' },
  { pattern: /(^|\/)eslint\.config\./, reason: 'ESLint config' },
  { pattern: /(^|\/)\.eslintrc/, reason: 'Legacy ESLint config' },
  { pattern: /(^|\/)esbuild\.config\./, reason: 'esbuild config' },
  { pattern: /\.test\.(ts|tsx|js|jsx|mjs|cjs)$/, reason: 'Test file' },
  { pattern: /\.spec\.(ts|tsx|js|jsx|mjs|cjs)$/, reason: 'Spec file' },
  { pattern: /(^|\/)__tests__\//, reason: 'Test directory' },
  { pattern: /(^|\/)coverage\//, reason: 'Coverage output' },
  { pattern: /(^|\/)\.env($|\.)/, reason: 'Environment file (secrets)' },
  { pattern: /(^|\/)\.git\//, reason: 'Git metadata' },
  { pattern: /(^|\/)\.github\//, reason: 'GitHub metadata' },
  { pattern: /(^|\/)\.husky\//, reason: 'Husky hooks' },
  { pattern: /(^|\/)node_modules\//, reason: 'node_modules' },
  { pattern: /\.tsbuildinfo$/, reason: 'TypeScript incremental build info' },
];

const REQUIRED_FILES = ['LICENSE', 'README.md', 'package.json'];

function runNpmPackDryRun() {
  try {
    const output = execSync('npm pack --dry-run --json', {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    return JSON.parse(output);
  } catch (err) {
    console.error('[verify-pack] npm pack --dry-run failed:');
    console.error(err.stderr || err.message);
    process.exit(1);
  }
}

function main() {
  const result = runNpmPackDryRun();
  const packInfo = Array.isArray(result) ? result[0] : result;
  if (!packInfo || !Array.isArray(packInfo.files)) {
    console.error('[verify-pack] unexpected npm pack output (no files array)');
    process.exit(1);
  }

  const files = packInfo.files.map((f) => f.path);
  const violations = [];

  for (const file of files) {
    for (const rule of FORBIDDEN_PATTERNS) {
      if (rule.except && rule.except.test(file)) continue;
      if (rule.pattern.test(file)) {
        violations.push({ file, reason: rule.reason });
        break;
      }
    }
  }

  const missing = REQUIRED_FILES.filter((req) => !files.some((f) => f === req || f.endsWith(`/${req}`)));

  if (violations.length > 0 || missing.length > 0) {
    console.error('\n[verify-pack] FAILED — tarball does not meet publish standards\n');
    if (violations.length > 0) {
      console.error('Forbidden files in tarball:');
      for (const v of violations) {
        console.error(`  ✗ ${v.file}  (${v.reason})`);
      }
    }
    if (missing.length > 0) {
      console.error('\nRequired files missing from tarball:');
      for (const m of missing) {
        console.error(`  ✗ ${m}`);
      }
    }
    console.error(`\nPackage: ${packInfo.name}@${packInfo.version}`);
    console.error(`Total files: ${files.length}, tarball size: ${packInfo.size} bytes\n`);
    process.exit(1);
  }

  console.log(`[verify-pack] OK — ${packInfo.name}@${packInfo.version}`);
  console.log(`  files: ${files.length}`);
  console.log(`  size:  ${packInfo.size} bytes (unpacked: ${packInfo.unpackedSize})`);
  console.log(`  shasum: ${packInfo.shasum}`);
  console.log('\nFiles included:');
  for (const f of files.sort()) {
    console.log(`  ${f}`);
  }
}

main();
