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
      state: z.enum([
        WorkstreamState.Queued,
        WorkstreamState.Held,
        WorkstreamState.Running,
        WorkstreamState.Verifying,
        WorkstreamState.Done,
      ]),
      /** False for a shared-mode project's batch, which has no worktree of its own. */
      worktree: z.boolean().default(true),
      /** A real branch and the commit it was cut from, in place of the title's slug and the zero sha. */
      branch: z.string().min(1).optional(),
      baseSha: z.string().length(40).optional(),
      /** The GitHub `owner/name` a cut records; a ship reads it before its gate. */
      repo: z.string().min(1).optional(),
    }),
  ),
  shipped: z.array(z.object({ title: z.string().min(1), prUrl: z.string().min(1) })),
});

/** The states a workstream passes through on its way from QUEUED. */
const PATH: Readonly<
  Record<'QUEUED' | 'HELD' | 'RUNNING' | 'VERIFYING' | 'DONE', readonly WorkstreamStateValue[]>
> = {
  QUEUED: [],
  HELD: [WorkstreamState.Held],
  RUNNING: [WorkstreamState.Starting, WorkstreamState.Running],
  VERIFYING: [WorkstreamState.Starting, WorkstreamState.Running, WorkstreamState.Verifying],
  DONE: [
    WorkstreamState.Starting,
    WorkstreamState.Running,
    WorkstreamState.Verifying,
    WorkstreamState.Done,
  ],
};

const [databasePath, json] = process.argv.slice(2);
if (!databasePath || !json) throw new Error('usage: seed-worktree-batches.ts <database> <json>');
const seed = Seed.parse(JSON.parse(json));
const store = createStore(openDatabase(databasePath));

const slug = (title: string): string => title.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-');

function cut(
  title: string,
  index: number,
  git: {
    readonly branch?: string;
    readonly baseSha?: string;
    readonly worktree?: boolean;
    readonly repo?: string;
  } = {},
): ReturnType<typeof insertBatch> {
  return store.write((ctx) => {
    const batch = insertBatch(ctx, {
      projectId: seed.projectId,
      title,
      baseBranch: 'main',
      ...(git.worktree === false
        ? {}
        : { worktreePath: `${seed.worktreeRoot}/${slug(title)}-${String(index)}` }),
    });
    patchBatch(ctx, batch.id, {
      branch: git.branch ?? `10db/${slug(title)}`,
      baseSha: git.baseSha ?? '0'.repeat(40),
      ...(git.repo === undefined ? {} : { repo: git.repo }),
    });
    return transitionBatch(ctx, batch.id, { to: BatchState.Open, reason: 'seeded' });
  }).value;
}

seed.open.forEach((entry, index) => {
  const batch = cut(entry.title, index, {
    worktree: entry.worktree,
    ...(entry.branch === undefined ? {} : { branch: entry.branch }),
    ...(entry.baseSha === undefined ? {} : { baseSha: entry.baseSha }),
    ...(entry.repo === undefined ? {} : { repo: entry.repo }),
  });
  store.write((ctx) => {
    const workstream = insertWorkstream(ctx, entry.taskId, {
      first: { model: 'seeded-model', effort: 'medium' },
      batchId: batch.id,
    });
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
