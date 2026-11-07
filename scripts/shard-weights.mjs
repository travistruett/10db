#!/usr/bin/env node
// Rewrites tests/repo/src/shard-weights.ts from the test timings of the newest three green runs of
// CI on main (docs/architecture/decisions/2026-11-07-shard-weights-come-from-mains-timings.md). A
// run that didn't leave every shard's timings is skipped. With fewer than three such runs it writes
// nothing and exits non-zero, so a failed lookup never replaces the weights with a guess.
// Usage: make shard-weights, or node scripts/shard-weights.mjs [<file to write>]. Needs gh signed in.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  everyShard,
  renderShardWeights,
  shardWeights,
} from '../tests/repo/src/shard-weights-from-timings.ts';
import { downloadTimings, mainRuns, timingArtifacts } from './main-timings.mjs';

const RUNS = 3;
const target =
  process.argv[2] ?? join(import.meta.dirname, '..', 'tests/repo/src/shard-weights.ts');

const view = spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
  encoding: 'utf8',
});
const repository = view.status === 0 ? view.stdout.trim() : '';
if (repository === '') {
  process.stderr.write(`gh repo view: ${view.stderr || String(view.error)}\n`);
  process.exit(1);
}

const runs = [];
for (const { id } of mainRuns(repository, { successOnly: true })) {
  if (runs.length === RUNS) break;
  if (timingArtifacts(repository, id) === 0) continue;
  const shards = downloadTimings(repository, id);
  if (shards === null || !everyShard(shards)) {
    process.stderr.write(`run ${String(id)}: skipped, its shards' timings are incomplete\n`);
    continue;
  }
  runs.push({ id, shards });
}
if (runs.length < RUNS) {
  process.stderr.write(
    `found ${String(runs.length)} of ${String(RUNS)} runs on main with every shard's timings; ` +
      'wrote nothing\n',
  );
  process.exit(1);
}

writeFileSync(
  target,
  renderShardWeights(
    shardWeights(runs),
    runs.map(({ id }) => id),
  ),
);
process.stdout.write(`wrote ${target} from main runs ${runs.map(({ id }) => id).join(', ')}\n`);
