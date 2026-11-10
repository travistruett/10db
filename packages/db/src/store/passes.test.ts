import {
  AbandonStep,
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
  abandonPassAndBatch,
  countLanes,
  createTestStore,
  findOpenPass,
  getBatch,
  getPass,
  getTask,
  getTaskKeptWork,
  getWorkstreamRow,
  insertBatch,
  insertPass,
  insertTask,
  insertWorkstream,
  joinPass,
  leavePass,
  listPassDirt,
  listLivePasses,
  listPassTasks,
  listUnfinishedAbandons,
  passHoldingFolder,
  passHoldingTask,
  passPageAreas,
  renamePass,
  seedProject,
  setAbandonStep,
  setTaskKeptWork,
  transitionBatch,
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

describe('the live passes', () => {
  it.each<{ state: PassState; live: boolean }>([
    { state: PassState.Open, live: true },
    { state: PassState.Closing, live: true },
    { state: PassState.Abandoning, live: true },
    { state: PassState.Closed, live: true },
    { state: PassState.Settled, live: false },
    { state: PassState.Abandoned, live: false },
  ])('lists a $state pass as live: $live', ({ state, live }) => {
    const { pass } = store.write((ctx) => insertPass(ctx, passInput([task()]))).value;
    store.db.update(schema.passes).set({ state }).where(eq(schema.passes.id, pass.id)).run();
    expect(listLivePasses(store.db).map((p) => p.id)).toEqual(live ? [pass.id] : []);
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

describe('joining a pass', () => {
  it('adds the tasks to the open pass, saying so, and the pass holds them', () => {
    const { pass } = store.write((ctx) => insertPass(ctx, passInput([task()]))).value;
    const joining = task(project, 'People: UI work');

    const { events } = store.write((ctx) => {
      joinPass(ctx, pass.id, [joining]);
    });

    expect(passHoldingTask(store.db, getTask(store.db, joining))?.id).toBe(pass.id);
    expect(listPassTasks(store.db, pass.id).map((t) => t.id)).toContain(joining);
    expect(events.map((e) => [e.type, e.entityId])).toEqual([
      [EventType.TaskChanged, joining],
      [EventType.PassChanged, pass.id],
    ]);
  });

  it.each<{ name: string; arrange: (passId: PassId) => TaskId; refusal: RegExp }>([
    {
      name: 'a pass that is not open',
      arrange: (passId) => {
        endPass(passId, PassState.Abandoning);
        return task();
      },
      refusal: /is abandoning: a page joins only an open pass/,
    },
    {
      name: 'a task the pass holds already',
      arrange: (passId) => {
        const [held] = listPassTasks(store.db, passId);
        if (!held) throw new Error('the pass holds one task');
        return held.id;
      },
      refusal: /is already in pass "Polish settings"/,
    },
    {
      name: 'a task of another project',
      arrange: () =>
        task(seedProject(store, { name: 'other', areas: [{ name: 'settings', globs: ['s/**'] }] })),
      refusal: /belongs to another project/,
    },
  ])('refuses $name, joining nothing', ({ arrange, refusal }) => {
    const { pass } = store.write((ctx) => insertPass(ctx, passInput([task()]))).value;
    const joining = arrange(pass.id);
    const before = getTask(store.db, joining).passId ?? null;

    expect(() =>
      store.write((ctx) => {
        joinPass(ctx, pass.id, [joining]);
      }),
    ).toThrow(refusal);
    expect(getTask(store.db, joining).passId ?? null).toBe(before);
  });
});

describe('renaming a pass', () => {
  it('names the pass and its batch anew in one write, and leaves the branch as it was', () => {
    const { pass, batch } = store.write((ctx) => insertPass(ctx, passInput([task()]))).value;

    const { value, events } = store.write((ctx) => renamePass(ctx, pass.id, 'Settings and people'));

    expect(value.name).toBe('Settings and people');
    expect(getPass(store.db, pass.id).name).toBe('Settings and people');
    expect(getBatch(store.db, batch.id)).toMatchObject({
      title: 'Settings and people',
      branch: batch.branch,
    });
    expect(events.map((e) => [e.type, e.entityId])).toEqual([
      [EventType.BatchUpdated, batch.id],
      [EventType.PassChanged, pass.id],
    ]);
  });

  it.each([PassState.Settled, PassState.Abandoned])('refuses a %s pass', (state) => {
    const { pass } = store.write((ctx) => insertPass(ctx, passInput([task()]))).value;
    endPass(pass.id, state);

    expect(() => store.write((ctx) => renamePass(ctx, pass.id, 'Later'))).toThrow(
      `is ${state.toLowerCase()}`,
    );
    expect(getPass(store.db, pass.id).name).toBe('Polish settings');
  });
});

describe('leaving a pass', () => {
  it('ends the membership: the pass no longer holds the task, and its lane counts for the project', () => {
    const t = task();
    const { pass, batch } = store.write((ctx) => insertPass(ctx, passInput([t]))).value;
    store.write((ctx) => {
      const ws = insertWorkstream(ctx, t, {
        batchId: batch.id,
        first: { model: 'claude-sonnet-5-5', effort: 'medium' },
      });
      transitionWorkstream(ctx, ws.id, { to: S.Starting, fence: null });
    });
    expect(countLanes(store.db).byPass.get(pass.id)).toBe(1);
    const { events } = store.write((ctx) => {
      leavePass(ctx, t);
    });
    expect(events.map((e) => e.type)).toContain(EventType.TaskChanged);
    expect(getTask(store.db, t).passId ?? null).toBeNull();
    expect(passHoldingTask(store.db, getTask(store.db, t))).toBeUndefined();
    expect(listPassTasks(store.db, pass.id)).toEqual([]);
    const lanes = countLanes(store.db);
    expect(lanes.byPass.get(pass.id)).toBeUndefined();
    expect(lanes.byProject.get(project.id)).toBe(1);
  });

  it("keeps a taken-out task's saved work and the commit it was kept on, says so on the task, and clears them", () => {
    const t = task();
    expect(getTaskKeptWork(store.db, t)).toBeNull();
    store.write((ctx) => {
      setTaskKeptWork(ctx, t, { keptSha: 'b'.repeat(40), keptBaseSha: 'a'.repeat(40) });
    });
    expect(getTaskKeptWork(store.db, t)).toEqual({
      keptSha: 'b'.repeat(40),
      keptBaseSha: 'a'.repeat(40),
    });
    // The Board reads it from the task: the drawer offers Discard Saved Work.
    expect(getTask(store.db, t).keptWork).toBe(true);
    store.write((ctx) => {
      setTaskKeptWork(ctx, t, null);
    });
    expect(getTaskKeptWork(store.db, t)).toBeNull();
    expect(getTask(store.db, t).keptWork).toBe(false);
  });
});

describe("a pass's Abandon", () => {
  it('records its steps: the first moves the pass to ABANDONING, and a step never goes back', () => {
    const { pass } = store.write((ctx) => insertPass(ctx, passInput([task()]))).value;
    const { events } = store.write((ctx) => {
      setAbandonStep(ctx, pass.id, AbandonStep.Abandoning);
    });
    expect(events.map((e) => e.type)).toContain(EventType.PassChanged);
    expect(getPass(store.db, pass.id).state).toBe(PassState.Abandoning);
    store.write((ctx) => {
      setAbandonStep(ctx, pass.id, AbandonStep.SessionsStopped);
    });
    expect(() =>
      store.write((ctx) => {
        setAbandonStep(ctx, pass.id, AbandonStep.ShipAborted);
      }),
    ).toThrow(/step 3/);
    expect(
      store.db.select().from(schema.passes).where(eq(schema.passes.id, pass.id)).get()?.abandonStep,
    ).toBe(AbandonStep.SessionsStopped);
  });

  it('moves the pass and its batch to ABANDONED in one write', () => {
    const { pass, batch } = store.write((ctx) => insertPass(ctx, passInput([task()]))).value;
    store.write((ctx) => {
      setAbandonStep(ctx, pass.id, AbandonStep.Abandoning);
    });
    store.write((ctx) => {
      setAbandonStep(ctx, pass.id, AbandonStep.PagesTakenOut);
    });
    store.write((ctx) => {
      abandonPassAndBatch(ctx, pass.id);
    });
    expect(getPass(store.db, pass.id).state).toBe(PassState.Abandoned);
    expect(getBatch(store.db, batch.id).state).toBe('ABANDONED');
    expect(findOpenPass(store.db, project.id)).toBeUndefined();
  });

  it('records its last step on the abandoned pass, and lists each pass whose Abandon has not finished', () => {
    const { pass } = store.write((ctx) => insertPass(ctx, passInput([task()]))).value;
    expect(listUnfinishedAbandons(store.db)).toEqual([]);
    store.write((ctx) => {
      setAbandonStep(ctx, pass.id, AbandonStep.Abandoning);
    });
    expect(listUnfinishedAbandons(store.db).map((p) => p.id)).toEqual([pass.id]);
    store.write((ctx) => {
      abandonPassAndBatch(ctx, pass.id);
    });
    expect(listUnfinishedAbandons(store.db).map((p) => p.id)).toEqual([pass.id]);
    store.write((ctx) => {
      setAbandonStep(ctx, pass.id, AbandonStep.IndexRefreshed);
    });
    expect(getPass(store.db, pass.id).state).toBe(PassState.Abandoned);
    expect(listUnfinishedAbandons(store.db)).toEqual([]);
  });

  it('moves neither when the batch cannot be abandoned', () => {
    const { pass, batch } = store.write((ctx) => insertPass(ctx, passInput([task()]))).value;
    store.write((ctx) => {
      setAbandonStep(ctx, pass.id, AbandonStep.Abandoning);
    });
    store.write((ctx) => transitionBatch(ctx, batch.id, { to: 'SHIPPING' }));
    expect(() =>
      store.write((ctx) => {
        abandonPassAndBatch(ctx, pass.id);
      }),
    ).toThrow(/from SHIPPING to ABANDONED/);
    expect(getPass(store.db, pass.id).state).toBe(PassState.Abandoning);
    expect(getBatch(store.db, batch.id).state).toBe('SHIPPING');
  });
});

describe("a pass's pages", () => {
  it("are the project's page areas and each area with no role a task of the pass holds", () => {
    const roled = seedProject(store, {
      name: 'roled',
      delivery: 'local',
      areas: [
        { name: 'settings', globs: ['src/settings/**'], role: 'page' },
        { name: 'people', globs: ['src/people/**'], role: 'page' },
        { name: 'profile', globs: ['src/profile/**'] },
        { name: 'billing', globs: ['src/billing/**'] },
        { name: 'src', globs: ['src/**'], role: 'shared' },
      ],
    });
    const add = (title: string, areas: string[]) =>
      store.write((ctx) => insertTask(ctx, roled.id, { title, acceptanceCriteria: ['x'], areas }))
        .value.id;
    const inPass = add('Settings', ['settings', 'profile', 'src']);
    const outside = add('Billing', ['people', 'billing']);
    const id = mintId('Pass');
    store.write((ctx) => insertPass(ctx, { ...passInput([inPass], id), projectId: roled.id }));
    expect(passPageAreas(store.db, id)).toEqual(['people', 'profile', 'settings']);
    expect(listPassTasks(store.db, id).map((t) => t.id)).toEqual([inPass]);
    expect(outside).toBeDefined();
  });
});
