import {
  BatchState,
  ProjectId,
  TaskId,
  WatchpointFileStatus,
  WatchpointLoudness,
  WorkstreamState,
  type WatchpointDetail,
} from '@10db/contracts';
import {
  createStore,
  getTask,
  insertBatch,
  insertWorkstream,
  openDatabase,
  patchBatch,
  transitionBatch,
  transitionWorkstream,
} from '@10db/db';
import { z } from 'zod';
import { raiseLookCard } from '../src/watchpoints';

/**
 * Seeds the Look card of a task whose change hit a watchpoint set to Hold, as the run's reading raises it for a pull
 * request not yet open: a batch with the task's finished workstream, and the card through `raiseLookCard` with the
 * landing that holds the pull request. `prUrl` is what the card names; no pull request exists behind it, so Merge
 * releases the hold and arms nothing. The rows are written straight into the database file of a daemon that is idle,
 * for the Inbox's end-to-end check. Usage: seed-held-look-card.ts <database> <json>
 */
const Seed = z.object({
  projectId: ProjectId,
  taskId: TaskId,
  batchTitle: z.string().min(1),
  prUrl: z.string().min(1),
  /** The watchpoint's key and label as the reading snapshots them. */
  watchpoint: z.object({ key: z.string().min(1), label: z.string().min(1) }),
});

const [databasePath, json] = process.argv.slice(2);
if (!databasePath || !json) throw new Error('usage: seed-held-look-card.ts <database> <json>');
const seed = Seed.parse(JSON.parse(json));
const store = createStore(openDatabase(databasePath));

store.write((ctx) => {
  const batch = insertBatch(ctx, {
    projectId: seed.projectId,
    title: seed.batchTitle,
    baseBranch: 'main',
  });
  patchBatch(ctx, batch.id, { branch: '10db/held-look-e2e', baseSha: '0'.repeat(40) });
  transitionBatch(ctx, batch.id, { to: BatchState.Open, reason: 'seeded' });
  const workstream = insertWorkstream(ctx, seed.taskId, {
    first: { model: 'seeded-model', effort: 'medium' },
    batchId: batch.id,
  });
  for (const to of [
    WorkstreamState.Starting,
    WorkstreamState.Running,
    WorkstreamState.Verifying,
    WorkstreamState.Done,
  ])
    transitionWorkstream(ctx, workstream.id, { to, fence: null, reason: 'seeded' });
  const detail: WatchpointDetail = {
    hits: [
      {
        watchpoint: {
          ...seed.watchpoint,
          why: 'A revert cannot undo a migration that ran.',
          guidance: 'Check that the migration can run on existing data.',
          loudness: WatchpointLoudness.Hold,
        },
        files: [
          {
            path: 'db/migrations/0001_greeting.sql',
            status: WatchpointFileStatus.Added,
            added: 1,
            removed: 0,
            patch: '@@ -0,0 +1 @@\n+create table greeting (name text);\n',
            clipped: false,
          },
        ],
        hash: 'a'.repeat(64),
      },
    ],
    head: '1'.repeat(40),
    skipped: null,
  };
  raiseLookCard(ctx, {
    workstreamId: workstream.id,
    projectId: seed.projectId,
    taskTitle: getTask(ctx.tx, seed.taskId).title,
    detail,
    landing: { batchId: batch.id, prUrl: seed.prUrl, alsoWaiting: [] },
  });
});
