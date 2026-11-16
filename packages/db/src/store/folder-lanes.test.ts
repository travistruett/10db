import {
  BatchState,
  mintId,
  WorkstreamState as S,
  type BatchId,
  type ProjectDto,
  type TaskId,
  type WorkstreamId,
} from '@10db/contracts';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../schema';
import { insertBatch } from './batches';
import { folderLanes } from './folder-lanes';
import { insertPass } from './passes';
import { insertSession } from './sessions';
import type { Store } from './store';
import { insertTask } from './tasks';
import { createTestStore, seedProject } from './test-support';
import { insertWorkstream } from './workstreams';

// Sessions spec §7.3: a run in Your folder holds it from its STARTING write until it lands or ends, and a
// shared batch from its cut until its switch back; a copy, a pass's page and a task never started hold none.

let store: Store;
let close: () => void;
let project: ProjectDto;
let hashes = 0;

beforeEach(() => {
  ({ store, close } = createTestStore(() => new Date('2026-11-15T12:00:00.000Z')));
  project = seedProject(store);
});
afterEach(() => {
  close();
});

interface Made {
  readonly taskId: TaskId;
  readonly workstreamId: WorkstreamId;
}

/** A run of a new task in `state`, with a session when it has had one, in `batchId`'s batch. */
function run(state: S, opts: { session?: boolean; batchId?: BatchId; title?: string } = {}): Made {
  return store.write((ctx) => {
    const task = insertTask(ctx, project.id, {
      title: opts.title ?? 'Bump vite',
      acceptanceCriteria: ['x'],
      areas: ['api'],
    });
    const ws = insertWorkstream(ctx, task.id, {
      ...(opts.batchId ? { batchId: opts.batchId } : {}),
      first: { model: 'claude-sonnet-5-5', effort: 'medium' },
    });
    ctx.tx
      .update(schema.workstreams)
      .set({ state, workspaceMode: 'shared' })
      .where(eq(schema.workstreams.id, ws.id))
      .run();
    if (opts.session) {
      hashes += 1;
      insertSession(ctx, {
        workstreamId: ws.id,
        provider: 'claude',
        model: 'sonnet',
        effort: 'medium',
        mode: 'managed',
        mcpTokenHash: `hash-${String(hashes)}`,
        accountId: project.accountId,
      });
    }
    return { taskId: task.id, workstreamId: ws.id };
  }).value;
}

function batch(
  state: BatchState,
  opts: { worktreePath?: string; returnSha?: string | null } = {},
): BatchId {
  return store.write((ctx) => {
    const b = insertBatch(ctx, {
      projectId: project.id,
      title: 'Shared batch',
      baseBranch: 'main',
      ...(opts.worktreePath ? { worktreePath: opts.worktreePath } : {}),
    });
    ctx.tx
      .update(schema.batches)
      .set({ state, returnSha: opts.returnSha ?? null, returnBranch: 'main' })
      .where(eq(schema.batches.id, b.id))
      .run();
    return b.id;
  }).value;
}

const names = () => folderLanes(store.db, project.id).map((l) => `${l.kind}:${l.name}`);

describe('folderLanes: a run in Your folder', () => {
  it.each([
    [S.Starting, false, true],
    [S.Running, true, true],
    [S.HandingOff, true, true],
    [S.Verifying, true, true],
    [S.WaitingHuman, true, true],
    [S.PausedLimit, true, true],
    [S.Recovering, true, true],
    [S.TakenOver, true, true],
    // Between steps the run keeps the folder once it has had a session; a task never started holds none.
    [S.Queued, true, true],
    [S.Held, true, true],
    [S.Queued, false, false],
    [S.Held, false, false],
    // A run that landed (a local commit) or ended holds nothing.
    [S.Done, true, false],
    [S.Failed, true, false],
    [S.Cancelled, true, false],
  ])('%s with session=%s holds=%s', (state, session, holds) => {
    run(state, { session });
    expect(names()).toEqual(holds ? ['task:Bump vite'] : []);
  });

  it('does not count a run in a separate copy', () => {
    const copy = batch(BatchState.Open, { worktreePath: '/tmp/copy' });
    run(S.Running, { session: true, batchId: copy });
    expect(names()).toEqual([]);
  });

  it('does not count a pass task, which its pass holds', () => {
    store.write((ctx) => {
      const task = insertTask(ctx, project.id, {
        title: 'Page',
        acceptanceCriteria: ['x'],
        areas: ['api'],
      });
      const opened = insertPass(ctx, {
        id: mintId('Pass'),
        projectId: project.id,
        name: 'Polish',
        pageCap: 4,
        returnBranch: 'main',
        startSha: 'a'.repeat(40),
        branch: '10db/polish-abc123',
        baseBranch: 'main',
        repo: null,
        taskIds: [task.id],
        dirt: [],
      });
      const ws = insertWorkstream(ctx, task.id, {
        batchId: opened.batch.id,
        first: { model: 'claude-sonnet-5-5', effort: 'medium' },
      });
      ctx.tx
        .update(schema.workstreams)
        .set({ state: S.Running })
        .where(eq(schema.workstreams.id, ws.id))
        .run();
    });
    expect(names()).toEqual([]);
  });
});

describe('folderLanes: a shared batch', () => {
  it.each([
    [BatchState.Cutting, null, true],
    [BatchState.Open, 'a'.repeat(40), true],
    [BatchState.Shipping, 'a'.repeat(40), true],
    [BatchState.Failed, 'a'.repeat(40), true],
    // After it ships it holds until the switch back has run and cleared its place.
    [BatchState.Shipped, 'a'.repeat(40), true],
    [BatchState.Shipped, null, false],
    [BatchState.Closed, 'a'.repeat(40), true],
    [BatchState.Closed, null, false],
    [BatchState.Abandoned, null, false],
  ])('%s with returnSha=%s holds=%s', (state, returnSha, holds) => {
    batch(state, { returnSha });
    expect(names()).toEqual(holds ? ['batch:Shared batch'] : []);
  });

  it('counts the batch once, not its lanes', () => {
    const b = batch(BatchState.Open, { returnSha: 'a'.repeat(40) });
    run(S.Running, { session: true, batchId: b });
    run(S.Queued, { session: true, batchId: b, title: 'Other' });
    expect(names()).toEqual(['batch:Shared batch']);
  });
});
