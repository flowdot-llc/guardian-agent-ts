#!/usr/bin/env node
/* c8 ignore start — thin binary shim invoking the library impl. */
import { parseArgs, runVerify, usageString } from '../src/cli/guardian-verify.js';

const parsed = parseArgs(process.argv.slice(2));
if (parsed === null) {
  process.stderr.write(usageString() + '\n');
  process.exit(2);
}

const result = await runVerify(parsed);
const stream = result.exitCode === 0 ? process.stdout : process.stderr;
stream.write(result.message + '\n');
process.exit(result.exitCode);
/* c8 ignore stop */
