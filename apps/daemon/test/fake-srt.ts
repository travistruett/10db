/**
 * Stands in for srt (`@anthropic-ai/sandbox-runtime`'s command line) in daemon tests that run no
 * Seatbelt: it reads the settings file as srt does, says so, and runs the command with no sandbox.
 * Node runs it directly, stripping the types. `test/gate-sandbox.seatbelt.test.ts` runs the real srt.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const [flag, settings, dashC, command] = process.argv.slice(2);
if (flag !== '--settings' || settings === undefined || dashC !== '-c' || command === undefined) {
  process.stderr.write('fake srt: expected --settings <file> -c <command>\n');
  process.exit(2);
}
const parsed: unknown = JSON.parse(readFileSync(settings, 'utf8'));
const domains =
  typeof parsed === 'object' && parsed !== null && 'network' in parsed ? parsed.network : null;
process.stderr.write(`fake srt: no sandbox; network ${JSON.stringify(domains)}\n`);
const result = spawnSync('/bin/bash', ['-c', command], { stdio: 'inherit' });
process.exit(result.status ?? 1);
