import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EventType,
  mintId,
  type PassDto,
  type ProjectDto,
  type TaskId,
  type WorkstreamId,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateDatabase, openDatabase } from '../database';
import * as schema from '../schema';
import {
  acquireClaims,
  closeHold,
  createStore,
  deleteSignOffWait,
  getPassProgress,
  holdRecord,
  insertDrop,
  insertHold,
  insertPass,
  insertSignOffWait,
  insertTask,
  insertWorkstream,
  listSharedChanges,
  listSignOffWaits,
  markLanded,
  maxGrantedSeq,
  openHolds,
  seedProject,
  upsertSharedChange,
  type Store,
} from './index';

// Workbench spec §7.2, §9.2, §11, §12: a pass's shared holds, its shared chain and its waiting
// sign-offs are rows, so a restart reads every one back.

let dir: string;
let dbPath: string;
let store: Store;
let closeDb: () => void;
let project: ProjectDto;
let pass: PassDto;
let settings: { taskId: TaskId; workstreamId: WorkstreamId };
let people: { taskId: TaskId; workstreamId: WorkstreamId };

function open(): void {
  const db = openDatabase(dbPath);
  migrateDatabase(db);
  store = createStore(db, () => new Date('2026-11-09T12:00:00.000Z'));
  closeDb = () => db.$client.close();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), '10db-pass-shared-'));
  dbPath = join(dir, 'db.sqlite');
  open();
  project = seedProject(store, {
    delivery: 'local',
    areas: [
      { name: 'settings', globs: ['src/settings/**'], role: 'page' },
      { name: 'people', globs: ['src/people/**'], role: 'page' },
      { name: 'ui', globs: ['src/ui/**'], role: 'shared' },
      { name: 'lib', globs: ['src/lib/**'], role: 'shared' },
    ],
  });
  const task = (title: string, area: string): TaskId =>
    store.write((ctx) =>
      insertTask(ctx, project.id, { title, acceptanceCriteria: ['x'], areas: [area] }),
    ).value.id;
  const settingsTask = task('Settings', 'settings');
  const peopleTask = task('People', 'people');
  const opened = store.write((ctx) =>
    insertPass(ctx, {
      id: mintId('Pass'),
      projectId: project.id,
      name: 'Polish',
      pageCap: 4,
      returnBranch: 'main',
      startSha: 'a'.repeat(40),
      branch: '10db/polish-abc123',
      baseBranch: 'main',
      repo: null,
      taskIds: [settingsTask, peopleTask],
      dirt: [],
    }),
  ).value;
  pass = opened.pass;
  const run = (taskId: TaskId) =>
    store.write((ctx) =>
      insertWorkstream(ctx, taskId, {
        batchId: opened.batch.id,
        first: { model: 'claude-sonnet-5-5', effort: 'medium' },
      }),
    ).value.id;
  settings = { taskId: settingsTask, workstreamId: run(settingsTask) };
  people = { taskId: peopleTask, workstreamId: run(peopleTask) };
});
afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

/** Grants the area's claim to the task's run and writes its hold, in one write, as a grant does. */
function grant(who: { taskId: TaskId; workstreamId: WorkstreamId }, area: string) {
  return store.write((ctx) => {
    const acquired = acquireClaims(ctx, {
      projectId: project.id,
      workstreamId: who.workstreamId,
      requests: [{ kind: 'area', name: area }],
      leaseExpiresAt: '2026-11-09T13:00:00.000Z',
    });
    if (!acquired.ok) throw new Error('claim not granted');
    const claim = acquired.claims.find((c) => c.name === area);
    if (claim === undefined) throw new Error('no claim row');
    return insertHold(ctx, {
      claimId: claim.id,
      passId: pass.id,
      taskId: who.taskId,
      workstreamId: who.workstreamId,
      area,
      recordSha: 'b'.repeat(40),
      record: [
        { path: `src/${area}/Button.tsx`, blob: 'c'.repeat(40) },
        { path: `src/${area}/old.ts`, blob: null },
      ],
    });
  }).value;
}

describe("a pass's shared holds", () => {
  it('numbers each grant after the last, and the unique index refuses a second writer with a stale number', () => {
    const first = grant(settings, 'ui');
    const second = grant(people, 'lib');
    expect([first.seq, second.seq]).toEqual([1, 2]);
    expect(maxGrantedSeq(store.db, pass.id)).toBe(2);
    expect(holdRecord(store.db, first.claimId)).toEqual([
      { path: 'src/ui/Button.tsx', blob: 'c'.repeat(40) },
      { path: 'src/ui/old.ts', blob: null },
    ]);
    // A writer that read the numbers before the second grant would write 2 again.
    const stale = store.write((ctx) => {
      const acquired = acquireClaims(ctx, {
        projectId: project.id,
        workstreamId: settings.workstreamId,
        requests: [{ kind: 'area', name: 'settings' }],
        leaseExpiresAt: '2026-11-09T13:00:00.000Z',
      });
      if (!acquired.ok) throw new Error('claim not granted');
      return acquired.claims[0]?.id;
    }).value;
    if (stale === undefined) throw new Error('no claim row');
    expect(() =>
      store.db
        .insert(schema.passHolds)
        .values({
          claimId: stale,
          passId: pass.id,
          taskId: settings.taskId,
          workstreamId: settings.workstreamId,
          area: 'settings',
          seq: 2,
          recordSha: 'b'.repeat(40),
          grantedAt: '2026-11-09T12:00:00.000Z',
          createdAt: '2026-11-09T12:00:00.000Z',
          updatedAt: '2026-11-09T12:00:00.000Z',
        })
        .run(),
    ).toThrow(/UNIQUE constraint failed: pass_holds\.pass_id, pass_holds\.seq/);
    expect(openHolds(store.db, pass.id).map((h) => h.seq)).toEqual([1, 2]);
  });

  it("keeps a hold's change and closes the hold in one write, replacing the change while the hold is open", () => {
    const hold = grant(settings, 'ui');
    store.write((ctx) =>
      upsertSharedChange(ctx, {
        passId: pass.id,
        seq: hold.seq,
        sha: 'd'.repeat(40),
        files: [{ path: 'src/ui/Button.tsx', blob: 'e'.repeat(40) }],
        dirtyKept: false,
      }),
    );
    const { events } = store.write((ctx) => {
      upsertSharedChange(ctx, {
        passId: pass.id,
        seq: hold.seq,
        sha: 'f'.repeat(40),
        files: [
          { path: 'src/ui/old.ts', blob: null },
          { path: 'src/ui/Button.tsx', blob: '1'.repeat(40) },
        ],
        dirtyKept: true,
      });
      return closeHold(ctx, hold.claimId, { empty: false });
    });
    expect(events.map((e) => [e.type, e.data])).toContainEqual([
      EventType.PassSharedChanged,
      {
        passId: pass.id,
        seq: 1,
        taskId: settings.taskId,
        paths: ['src/ui/Button.tsx', 'src/ui/old.ts'],
      },
    ]);
    closeDb();
    open();
    expect(openHolds(store.db, pass.id)).toEqual([]);
    expect(listSharedChanges(store.db, pass.id)).toEqual([
      expect.objectContaining({
        seq: 1,
        taskId: settings.taskId,
        sha: 'f'.repeat(40),
        paths: ['src/ui/Button.tsx', 'src/ui/old.ts'],
        blobs: { 'src/ui/Button.tsx': '1'.repeat(40), 'src/ui/old.ts': null },
        dirtyKept: true,
        landedSha: null,
        droppedBy: null,
        dropOf: null,
      }),
    ]);
    // Once the hold is closed its change is no longer replaced, and a hold is closed once.
    expect(() =>
      store.write((ctx) =>
        upsertSharedChange(ctx, {
          passId: pass.id,
          seq: 1,
          sha: '2'.repeat(40),
          files: [{ path: 'src/ui/Button.tsx', blob: '2'.repeat(40) }],
          dirtyKept: false,
        }),
      ),
    ).toThrow(/closed/);
    expect(() => store.write((ctx) => closeHold(ctx, hold.claimId, { empty: true }))).toThrow(
      /closed/,
    );
  });

  it('records a drop as a change of its own, numbered after the rest, and lands the chain in order only', () => {
    const ui = grant(settings, 'ui');
    store.write((ctx) => {
      upsertSharedChange(ctx, {
        passId: pass.id,
        seq: ui.seq,
        sha: 'd'.repeat(40),
        files: [{ path: 'src/ui/Button.tsx', blob: 'e'.repeat(40) }],
        dirtyKept: false,
      });
      closeHold(ctx, ui.claimId, { empty: false });
    });
    const lib = grant(people, 'lib');
    store.write((ctx) => closeHold(ctx, lib.claimId, { empty: true }));
    const drop = store.write((ctx) =>
      insertDrop(ctx, {
        passId: pass.id,
        of: ui.seq,
        sha: '3'.repeat(40),
        files: [{ path: 'src/ui/Button.tsx', blob: 'c'.repeat(40) }],
      }),
    ).value;
    expect(drop).toMatchObject({ seq: 3, taskId: settings.taskId, dropOf: 1 });
    expect(maxGrantedSeq(store.db, pass.id)).toBe(3);
    expect(listSharedChanges(store.db, pass.id).map((c) => [c.seq, c.droppedBy, c.dropOf])).toEqual(
      [
        [1, 3, null],
        [3, null, 1],
      ],
    );
    expect(() =>
      store.write((ctx) =>
        insertDrop(ctx, { passId: pass.id, of: ui.seq, sha: '4'.repeat(40), files: [] }),
      ),
    ).toThrow(/dropped/);
    // The next grant is numbered after the drop.
    expect(grant(settings, 'settings').seq).toBe(4);

    store.write((ctx) => {
      markLanded(ctx, { passId: pass.id, seq: 2, landedSha: null });
    });
    expect(getPassProgress(store.db, pass.id).sharedLanded).toBe(2);
    expect(() =>
      store.write((ctx) => {
        markLanded(ctx, { passId: pass.id, seq: 1, landedSha: '5'.repeat(40) });
      }),
    ).toThrow(/landed/);
  });
});

describe("a pass's waiting sign-offs", () => {
  it("survives a restart, names the hold's task, and is deleted once", () => {
    const hold = grant(people, 'ui');
    const { events } = store.write((ctx) =>
      insertSignOffWait(ctx, { taskId: settings.taskId, passId: pass.id, waitsFor: hold.claimId }),
    );
    expect(events.map((e) => e.type)).toEqual([EventType.PassChanged]);
    closeDb();
    open();
    expect(listSignOffWaits(store.db, pass.id)).toEqual([
      {
        taskId: settings.taskId,
        passId: pass.id,
        waitsFor: hold.claimId,
        waitsForTaskId: people.taskId,
        askedAt: '2026-11-09T12:00:00.000Z',
      },
    ]);
    expect(listSignOffWaits(store.db).map((w) => w.taskId)).toEqual([settings.taskId]);
    expect(store.write((ctx) => deleteSignOffWait(ctx, settings.taskId)).value).toBe(true);
    expect(store.write((ctx) => deleteSignOffWait(ctx, settings.taskId)).value).toBe(false);
    expect(listSignOffWaits(store.db, pass.id)).toEqual([]);
  });

  it('is refused for a hold already closed: there is nothing to wait for', () => {
    const hold = grant(people, 'ui');
    store.write((ctx) => closeHold(ctx, hold.claimId, { empty: true }));
    expect(() =>
      store.write((ctx) =>
        insertSignOffWait(ctx, {
          taskId: settings.taskId,
          passId: pass.id,
          waitsFor: hold.claimId,
        }),
      ),
    ).toThrow(/closed/);
  });
});
