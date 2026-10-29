import {
  BatchState,
  TaskId,
  WorkstreamState,
  ProjectId,
  type WorkstreamState as WorkstreamStateValue,
} from '@10db/contracts';
import {
  createStore,
  insertBatch,
  insertWorkstream,
  openDatabase,
  patchBatch,
  transitionBatch,
  transitionWorkstream,
} from '@10db/db';
import { z } from 'zod';

/**
 * Seeds a worktree-mode project for the Board's end-to-end layout check: one open batch per task,
 * each with its workstream in the state the list names, and one shipped batch for the history.
 * Starting real batches needs a GitHub origin and a signed-in gh, which a disposable test repository
 * has neither of, so the rows are written straight into the database file of a daemon that is idle
 * on them. Usage: seed-worktree-batches.ts <database> <json>
 */
const Seed = z.object({
  projectId: ProjectId,
  worktreeRoot: z.string().min(1),
  open: z.array(
    z.object({
      taskId: TaskId,
      title: z.string().min(1),
      state: z.enum([WorkstreamState.Queued, WorkstreamState.Running, WorkstreamState.Verifying]),
    }),
  ),
  shipped: z.array(z.object({ title: z.string().min(1), prUrl: z.string().min(1) })),
});

/** The states a workstream passes through on its way from QUEUED. */
const PATH: Readonly<Record<'QUEUED' | 'RUNNING' | 'VERIFYING', readonly WorkstreamStateValue[]>> =
  {
    QUEUED: [],
    RUNNING: [WorkstreamState.Starting, WorkstreamState.Running],
    VERIFYING: [WorkstreamState.Starting, WorkstreamState.Running, WorkstreamState.Verifying],
  };

const [databasePath, json] = process.argv.slice(2);
if (!databasePath || !json) throw new Error('usage: seed-worktree-batches.ts <database> <json>');
const seed = Seed.parse(JSON.parse(json));
const store = createStore(openDatabase(databasePath));

const slug = (title: string): string => title.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-');

function cut(title: string, index: number): ReturnType<typeof insertBatch> {
  return store.write((ctx) => {
    const batch = insertBatch(ctx, {
      projectId: seed.projectId,
      title,
      baseBranch: 'main',
      worktreePath: `${seed.worktreeRoot}/${slug(title)}-${String(index)}`,
    });
    patchBatch(ctx, batch.id, { branch: `10db/${slug(title)}`, baseSha: '0'.repeat(40) });
    return transitionBatch(ctx, batch.id, { to: BatchState.Open, reason: 'seeded' });
  }).value;
}

seed.open.forEach((entry, index) => {
  const batch = cut(entry.title, index);
  store.write((ctx) => {
    const workstream = insertWorkstream(ctx, entry.taskId, { batchId: batch.id });
    for (const to of PATH[entry.state]) {
      transitionWorkstream(ctx, workstream.id, { to, fence: null, reason: 'seeded' });
    }
  });
});

seed.shipped.forEach((entry, index) => {
  const batch = cut(entry.title, seed.open.length + index);
  store.write((ctx) => {
    transitionBatch(ctx, batch.id, { to: BatchState.Shipping, reason: 'seeded' });
    transitionBatch(ctx, batch.id, {
      to: BatchState.Shipped,
      patch: { prUrl: entry.prUrl },
      reason: 'seeded',
    });
  });
});
