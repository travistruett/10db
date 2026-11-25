import { execFileSync } from 'node:child_process';
import { mintId } from '@10db/contracts';
import { createTestStore } from '@10db/db';
import { z } from 'zod';
import { systemClock } from '../src/clock';
import { createEventBus, createStateStore } from '../src/events';
import { createGit } from '../src/git';
import { createJudge, type Judge } from '../src/judge';
import { silentLogger } from '../src/log';
import { judgeNewTests } from '../src/test-value';

/**
 * Replays the test_value judge over the test-adding commits of the last merged pull requests, for the hand check of
 * its flags: one line per flagged new test with the answer, its confidence and the test it names. Pull requests are
 * squash-merged, so each is the one commit on main's first-parent line.
 *
 *   OPENROUTER_API_KEY=<key> pnpm --filter @10db/daemon exec tsx scripts/test-value-replay.ts [count]
 *
 * The key is read from the environment and used for these calls only; nothing is stored. Without it no model is
 * called: every test is answered keep, which counts what the judge would be shown.
 */
const Env = z.object({ OPENROUTER_API_KEY: z.string().min(1).optional() });
const key = Env.parse(process.env).OPENROUTER_API_KEY;
const count = z.coerce.number().int().min(1).max(100).default(20).parse(process.argv[2]);

const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const merged = execFileSync(
  'git',
  ['-C', repo, 'log', '--first-parent', '--format=%H %s', '-n', String(count * 3), 'origin/main'],
  { encoding: 'utf8' },
)
  .trim()
  .split('\n')
  .map((line) => ({ sha: line.slice(0, 40), subject: line.slice(41) }))
  .filter((c) => /\(#\d+\)$/.test(c.subject))
  .slice(0, count);

let shown = 0;
const keepAll: Judge = {
  off: false,
  ready: () => Promise.resolve(true),
  choose: () => {
    shown += 1;
    return Promise.resolve({
      kind: 'answered',
      choice: 'keep',
      confidence: 1,
      model: 'none',
      latencyMs: 0,
      costUsd: null,
      callId: mintId('JudgeCall'),
    });
  },
  assess: () =>
    Promise.resolve({
      kind: 'fallback',
      reason: 'off',
      detail: 'off',
      callId: mintId('JudgeCall'),
    }),
};

function judgeFor(apiKey: string): Judge {
  const { store } = createTestStore();
  return createJudge({
    state: createStateStore(store, createEventBus()),
    clock: systemClock,
    fetch,
    readCredential: () => Promise.resolve({ kind: 'openrouter', key: apiKey }),
    decisionModelIds: () => null,
    off: false,
    logger: silentLogger,
  });
}

const judge = key === undefined ? keepAll : judgeFor(key);
const git = createGit();
let flags = 0;
for (const pr of merged) {
  const parent = execFileSync('git', ['-C', repo, 'rev-parse', `${pr.sha}^1`], {
    encoding: 'utf8',
  }).trim();
  const found = await judgeNewTests(
    { git, judge, floor: 0.8, logger: silentLogger },
    { checkout: repo, base: parent, head: pr.sha, taskId: mintId('Task') },
  );
  flags += found.length;
  console.log(`\n${pr.subject}`);
  for (const f of found) {
    const existing =
      f.existing === null
        ? ''
        : `  ->  ${f.existing.file}:${String(f.existing.line)} "${f.existing.name}"`;
    console.log(
      `  ${f.verdict} (${f.confidence.toFixed(2)})  ${f.test.file}:${String(f.test.line)} "${f.test.name}"${existing}`,
    );
  }
}
console.log(
  key === undefined
    ? `\nNo key: ${String(shown)} new tests would be asked about across ${String(merged.length)} pull requests; no model was called.`
    : `\n${String(flags)} flags across ${String(merged.length)} pull requests.`,
);
