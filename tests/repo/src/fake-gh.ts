import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { z } from 'zod';

/** One canned reply: the first row whose `args` prefix the command's arguments answers it. */
export interface GhReply {
  readonly args: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly status?: number;
}

const GhCall = z.object({ args: z.string(), stdin: z.string() });
export type GhCall = z.infer<typeof GhCall>;

// gh is the network boundary, so a stand-in on PATH answers from the table and logs every call.
const FAKE_GH = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2).join(' ');
const stdin = args.includes('--input -') ? readFileSync(0, 'utf8') : '';
appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args, stdin }) + '\\n');
const replies = JSON.parse(readFileSync(process.env.FAKE_GH_REPLIES, 'utf8'));
const reply = replies.find((row) => args.startsWith(row.args));
if (!reply) {
  process.stderr.write('no canned reply for: ' + args);
  process.exit(99);
}
process.stdout.write(reply.stdout ?? '');
process.stderr.write(reply.stderr ?? '');
// Not process.exit, which would cut off output still draining to a pipe.
process.exitCode = reply.status ?? 0;
`;

/** Runs a Node script with the fake gh first on PATH; returns its result and every gh call made. */
export function runWithFakeGh(
  script: string,
  replies: readonly GhReply[],
  env: Readonly<Record<string, string>>,
) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-gh-'));
  try {
    const gh = join(dir, 'gh');
    const log = join(dir, 'calls.jsonl');
    const repliesPath = join(dir, 'replies.json');
    writeFileSync(gh, FAKE_GH.replace('#!/usr/bin/env node', `#!${process.execPath}`));
    chmodSync(gh, 0o755);
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    writeFileSync(repliesPath, JSON.stringify(replies));
    const result = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: {
        PATH: `${dir}${delimiter}${process.env['PATH'] ?? ''}`,
        FAKE_GH_LOG: log,
        FAKE_GH_REPLIES: repliesPath,
        ...env,
      },
    });
    const lines = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
    const calls = lines.map((line) => GhCall.parse(JSON.parse(line)));
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
