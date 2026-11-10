import {
  EventType,
  mintId,
  PassState,
  WorkstreamState as S,
  type PassId,
  type ProjectDto,
  type TaskId,
} from '@10db/contracts';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../schema';
import {
  countLanes,
  createTestStore,
  findOpenPass,
  getBatch,
  getPass,
  getTask,
  getWorkstreamRow,
  insertBatch,
  insertPass,
  insertTask,
  insertWorkstream,
  listPassDirt,
  passHoldingFolder,
  passHoldingTask,
  seedProject,
  transitionWorkstream,
  type PassInsert,
  type Store,
} from './index';

// Workbench spec §5.1, §5.2, §11: a pass's rows, its batch, and the lanes its tasks hold.

let store: Store;
let close: () => void;
let project: ProjectDto;

beforeEach(() => {
  ({ store, close } = createTestStore(() => new Date('2026-11-09T12:00:00.000Z')));
  project = seedProject(store, {
    delivery: 'local',
    areas: [{ name: 'settings', globs: ['src/settings/**'], role: 'page', route: '/settings' }],
  });
});
afterEach(() => {
  close();
});

const task = (p: ProjectDto = project, title = 'Settings: UI work'): TaskId =>
  store.write((ctx) =>
    insertTask(ctx, p.id, { title, acceptanceCriteria: ['x'], areas: ['settings'] }),
  ).value.id;

const passInput = (taskIds: readonly TaskId[], id: PassId = mintId('Pass')): PassInsert => ({
  id,
  projectId: project.id,
  name: 'Polish settings',
  pageCap: 4,
  returnBranch: 'main',
  startSha: 'a'.repeat(40),
  branch: '10db/polish-settings-abc123',
  baseBranch: 'main',
  repo: null,
  taskIds,
  dirt: [
    { path: 'src/settings/page.tsx', blob: 'b'.repeat(40) },
    { path: 'src/old.ts', blob: null },
  ],
});

describe('insertPass', () => {
  it('writes the pass, its open batch on the branch at the start, the dirt and each task in it', () => {
    const t = task();
    const { value, events } = store.write((ctx) => insertPass(ctx, passInput([t])));
    const { pass, batch } = value;
    expect(pass).toMatchObject({
      state: PassState.Open,
      batchId: batch.id,
      returnBranch: 'main',
      startSha: 'a'.repeat(40),
      pageCap: 4,
    });
    expect(getBatch(store.db, batch.id)).toMatchObject({
      state: 'OPEN',
      passId: pass.id,
      branch: '10db/polish-settings-abc123',
      baseSha: 'a'.repeat(40),
      repo: null,
      worktreePath: null,
    });
    expect(listPassDirt(store.db, pass.id)).toEqual([
      { path: 'src/old.ts', blob: null },
      { path: 'src/settings/page.tsx', blob: 'b'.repeat(40) },
    ]);
    expect(getTask(store.db, t).passId).toBe(pass.id);
    expect(events.map((e) => e.type)).toContain(EventType.PassOpened);
    expect(findOpenPass(store.db, project.id)?.id).toBe(pass.id);
    expect(passHoldingFolder(store.db, project.id)?.id).toBe(pass.id);
  });

  it.each<{ name: string; arrange: () => PassInsert; refusal: RegExp }>([
    {
      name: 'a second open pass in the project',
      arrange: () => {
        store.write((ctx) => insertPass(ctx, passInput([task()])));
        return passInput([task()]);
      },
      refusal: /Pass "Polish settings" is still open/,
    },
    {
      name: 'an unfinished batch in Your folder',
      arrange: () => {
        store.write((ctx) =>
          insertBatch(ctx, { projectId: project.id, title: 'b', baseBranch: 'main' }),
        );
        return passInput([task()]);
      },
      refusal: /Batch "b" in Your folder is still cutting/,
    },
    {
      name: 'a task of another project',
      arrange: () =>
        passInput([
          task(
            seedProject(store, {
              name: 'other',
              areas: [{ name: 'settings', globs: ['src/settings/**'] }],
            }),
          ),
        ]),
      refusal: /belongs to another project/,
    },
    {
      name: 'a task an open pass holds',
      arrange: () => {
        const t = task();
        store.write((ctx) => insertPass(ctx, passInput([t])));
        return passInput([t]);
      },
      refusal: /already in pass "Polish settings"/,
    },
  ])('refuses $name and writes nothing', ({ arrange, refusal }) => {
    const input = arrange();
    const before = store.db.select().from(schema.passes).all().length;
    expect(() => store.write((ctx) => insertPass(ctx, input))).toThrow(refusal);
    expect(store.db.select().from(schema.passes).all()).toHaveLength(before);
    expect(() => getPass(store.db, input.id)).toThrow(/not found/);
  });

  it('lets one pass per project be open, closing or abandoning, and another once it is settled', () => {
    const first = store.write((ctx) => insertPass(ctx, passInput([task()]))).value;
    for (const state of [PassState.Closing, PassState.Abandoning]) {
      store.db
        .update(schema.passes)
        .set({ state })
        .where(eq(schema.passes.id, first.pass.id))
        .run();
      expect(() =>
        store.db
          .insert(schema.passes)
          .values({
            ...getPass(store.db, first.pass.id),
            id: mintId('Pass'),
            state: PassState.Open,
          })
          .run(),
      ).toThrow(/UNIQUE constraint failed/);
    }
    // A closed pass no longer counts as open, but still holds the folder until it settles (W9).
    store.db
      .update(schema.passes)
      .set({ state: PassState.Closed })
      .where(eq(schema.passes.id, first.pass.id))
      .run();
    expect(findOpenPass(store.db, project.id)).toBeUndefined();
    expect(passHoldingFolder(store.db, project.id)?.id).toBe(first.pass.id);
    // The index is partial: beside a closed pass, a second one may be open.
    const second = mintId('Pass');
    store.db
      .insert(schema.passes)
      .values({ ...getPass(store.db, first.pass.id), id: second, state: PassState.Open })
      .run();
    expect(findOpenPass(store.db, project.id)?.id).toBe(second);
    store.db.delete(schema.passes).where(eq(schema.passes.id, second)).run();
    store.db
      .update(schema.passes)
      .set({ state: PassState.Settled })
      .where(eq(schema.passes.id, first.pass.id))
      .run();
    expect(passHoldingFolder(store.db, project.id)).toBeUndefined();
  });
});

/** Moves a pass and its batch on by hand, as its close or Abandon will. */
function endPass(passId: PassId, state: PassState): void {
  store.db.update(schema.passes).set({ state }).where(eq(schema.passes.id, passId)).run();
  const batchState = state === PassState.Abandoned ? 'ABANDONED' : 'SHIPPED';
  store.db
    .update(schema.batches)
    .set({ state: batchState })
    .where(eq(schema.batches.passId, passId))
    .run();
}

describe("a pass's hold on its tasks", () => {
  it('lets a task of an abandoned pass join another pass', () => {
    const t = task();
    const first = store.write((ctx) => insertPass(ctx, passInput([t]))).value;
    endPass(first.pass.id, PassState.Abandoned);
    const second = store.write((ctx) => insertPass(ctx, passInput([t]))).value;
    expect(getTask(store.db, t).passId).toBe(second.pass.id);
  });

  it.each<{ state: PassState; holds: boolean }>([
    { state: PassState.Open, holds: true },
    { state: PassState.Closing, holds: true },
    { state: PassState.Abandoning, holds: true },
    { state: PassState.Closed, holds: false },
    { state: PassState.Settled, holds: false },
    { state: PassState.Abandoned, holds: false },
  ])('a $state pass holds its task from an ordinary run: $holds', ({ state, holds }) => {
    const t = task();
    const { pass, batch } = store.write((ctx) => insertPass(ctx, passInput([t]))).value;
    store.db.update(schema.passes).set({ state }).where(eq(schema.passes.id, pass.id)).run();
    expect(passHoldingTask(store.db, getTask(store.db, t))?.id).toBe(holds ? pass.id : undefined);
    const ordinary = () =>
      store.write((ctx) =>
        insertWorkstream(ctx, t, { first: { model: 'claude-sonnet-5-5', effort: 'medium' } }),
      ).value;
    if (holds) {
      expect(ordinary).toThrow(/in the Workbench pass "Polish settings"/);
      // Its own batch still takes a run of it.
      const own = store.write((ctx) =>
        insertWorkstream(ctx, t, {
          batchId: batch.id,
          first: { model: 'claude-sonnet-5-5', effort: 'medium' },
        }),
      ).value;
      expect(getWorkstreamRow(store.db, own.id).batchId).toBe(batch.id);
    } else {
      expect(getWorkstreamRow(store.db, ordinary().id).batchId).toBeNull();
    }
  });
});

describe('countLanes with a pass', () => {
  it("leaves a pass's lanes out of its project's count and counts them for the pass, the account and the daemon", () => {
    const inPass = task();
    const ordinary = task(project, 'Ordinary');
    const { pass, batch } = store.write((ctx) => insertPass(ctx, passInput([inPass]))).value;
    store.write((ctx) => {
      for (const [id, batchId] of [
        [inPass, batch.id],
        [ordinary, null],
      ] as const) {
        const ws = insertWorkstream(ctx, id, {
          batchId,
          first: { model: 'claude-sonnet-5-5', effort: 'medium' },
        });
        transitionWorkstream(ctx, ws.id, { to: S.Starting, fence: null });
        transitionWorkstream(ctx, ws.id, { to: S.Running, fence: null });
      }
    });
    const lanes = countLanes(store.db);
    expect(lanes.global).toBe(2);
    expect(lanes.byAccount.get(project.accountId)).toBe(2);
    expect(lanes.byProject.get(project.id)).toBe(1);
    expect(lanes.byPass.get(pass.id)).toBe(1);
  });

  it('counts the lane of a task its abandoned pass no longer holds for its project', () => {
    const t = task();
    const { pass } = store.write((ctx) => insertPass(ctx, passInput([t]))).value;
    endPass(pass.id, PassState.Abandoned);
    store.write((ctx) => {
      const ws = insertWorkstream(ctx, t, {
        first: { model: 'claude-sonnet-5-5', effort: 'medium' },
      });
      transitionWorkstream(ctx, ws.id, { to: S.Starting, fence: null });
    });
    const lanes = countLanes(store.db);
    expect(lanes.byProject.get(project.id)).toBe(1);
    expect(lanes.byPass.get(pass.id)).toBeUndefined();
  });
});
