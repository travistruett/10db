import {
  ConflictError,
  InboxState,
  PASS_SIGN_OFF_CHOICE,
  WorkstreamState as S,
  type TaskDto,
  type WorkstreamState,
} from '@10db/contracts';
import {
  acquireClaims,
  activeClaims,
  claimRequestsForTask,
  getInboxItem,
  getProject,
  getWorkstreamRow,
  insertInboxItem,
  insertWorkstream,
  latestPassTurn,
  listSharedChanges,
  listSignOffWaits,
  listTaskThread,
  openHolds,
  transitionWorkstream,
  updateInboxItem,
} from '@10db/db';
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import { openPassWorld, type PassWorld } from '../../test/pass-world';
import { GitTrustError, GitTrustFailure, type Git } from '../git';
import {
  abandonPass,
  grantSharedHold,
  keepHold,
  keepTurnWork,
  takeOut,
  TakeOutWithin,
} from './index';
import {
  cancelSignOffWait,
  finishSignOff,
  signOffRefusal,
  signOffSteps,
  SignOffFrom,
  startSignOff,
  type SignOffDeps,
} from './sign-off';

// Workbench spec §9.2, §7.2 (D17): Sign Off stops the page, lands the shared changes it needs in
// chain order and then the page's own files as one commit, and ends its run in one write; a crash
// at any point is recovered by the operation ids of the commits already made.

const stopped = (): Promise<void> => Promise.resolve();

let w: PassWorld;

/** `task` takes a turn in which `edit` writes; holding `src` when `shared`, kept at the turn's end. */
async function turn(task: TaskDto, edit: () => void, shared = false): Promise<void> {
  const open = w.startTurn(task);
  const ws = w.runOf(task);
  if (shared) {
    const granted = await grantSharedHold(w.deps, { workstreamId: ws, area: 'src' });
    if (!granted?.ok) throw new Error('src was not granted');
  }
  edit();
  for (const hold of openHolds(w.h.store.db, w.opened.pass.id))
    if (hold.taskId === task.id) await keepHold(w.deps, { claimId: hold.claimId });
  w.endTurn(open);
  await keepTurnWork(w.deps, { workstreamId: ws, turnId: open.id });
}

/** The page's run waits on the builder with an open `check` item, as a Ready page does. */
function ready(task: TaskDto): void {
  const ws = w.runOf(task);
  w.h.state.write((ctx) => {
    // A page waiting on the builder runs again when a message starts its next turn.
    const path =
      getWorkstreamRow(ctx.tx, ws).state === S.WaitingHuman ? [S.Running] : [S.Starting, S.Running];
    for (const to of path) transitionWorkstream(ctx, ws, { to, fence: null });
    const item = insertInboxItem(ctx, {
      projectId: w.h.project.id,
      kind: 'check',
      title: `Ready: ${task.title}`,
      body: 'Ready.',
      options: [{ label: PASS_SIGN_OFF_CHOICE, description: 'The page is right' }],
      recommendation: null,
      category: 'product',
      urgency: 'normal',
      detail: null,
      foldKey: null,
      targets: [{ workstreamId: ws, sessionId: null }],
    });
    transitionWorkstream(ctx, ws, {
      to: S.WaitingHuman,
      fence: null,
      patch: { nextAction: { kind: 'pass_review', inboxId: item.id } },
    });
  });
}

const signOff = (task: TaskDto, deps: SignOffDeps = { ...w.deps, stopLane: stopped }) =>
  signOffSteps(deps, { taskId: task.id, from: SignOffFrom.Page });

/** The subjects of the commits the pass's branch has since its start, oldest first. */
const landed = () =>
  w.h
    .git$('log', '--reverse', '--format=%s', `${w.opened.pass.startSha}..${w.branch}`)
    .split('\n')
    .filter(Boolean);

const onBranch = (path: string) => w.h.git$('show', `${w.branch}:${path}`);

describe('signOffSteps', () => {
  afterEach(() => {
    w.close();
  });

  it("lands the page's files and its hazard file as one commit, and ends the run in one write", async () => {
    w = await openPassWorld();
    // The scheduler claims the task's areas and hazards when it launches.
    w.h.state.write((c) =>
      acquireClaims(c, {
        projectId: w.h.project.id,
        workstreamId: w.runOf(w.settings),
        requests: claimRequestsForTask(w.settings, getProject(c.tx, w.h.project.id)),
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    w.write('src/notes.md', 'dirt no page owns\n');
    await turn(w.settings, () => {
      w.write('src/settings/page.tsx', 'tidied\n');
      w.write('pnpm-lock.yaml', 'lock: 2\n');
      w.write('src/people/page.tsx', "a neighbour's edit\n");
    });
    // The builder's edit after the turn rides the sign-off's fold.
    w.write('src/settings/old.tsx', 'edited by hand\n');
    ready(w.settings);

    const done = await signOff(w.settings);

    expect(done).toMatchObject({ kind: 'signed_off', sharedLanded: [] });
    expect(landed()).toEqual(['Settings: UI work']);
    expect(done.kind === 'signed_off' ? [...done.files] : []).toEqual([
      'pnpm-lock.yaml',
      'src/settings/old.tsx',
      'src/settings/page.tsx',
    ]);
    expect(onBranch('src/settings/page.tsx')).toBe('tidied');
    expect(onBranch('src/settings/old.tsx')).toBe('edited by hand');
    expect(onBranch('src/people/page.tsx')).toBe('people');
    expect(w.h.git$('log', '-1', '--format=%(trailers:key=10db-task,valueonly)', w.branch)).toBe(
      w.settings.id,
    );
    const ws = w.runOf(w.settings);
    expect(getWorkstreamRow(w.h.store.db, ws).state).toBe('DONE');
    expect(activeClaims(w.h.store.db, ws)).toEqual([]);
    expect(latestPassTurn(w.h.store.db, w.settings.id)?.answeredAt).not.toBeNull();
    const row = getWorkstreamRow(w.h.store.db, ws);
    if (row.nextAction.kind !== 'pass_review') throw new Error('no item');
    expect(getInboxItem(w.h.store.db, row.nextAction.inboxId)).toMatchObject({
      state: 'RESOLVED',
      answer: { choice: PASS_SIGN_OFF_CHOICE },
    });
    const sha = w.h.git$('rev-parse', '--short=7', w.branch);
    expect(listTaskThread(w.h.store.db, w.settings.id).at(-1)?.body).toBe(
      `Signed off · landed as \`${sha}\` · 3 files`,
    );
    // The neighbour's edit and the dirt no page owns are still in the folder, uncommitted.
    expect(w.h.git$('status', '--porcelain', '--', 'src/people', 'src/notes.md')).toBe(
      'M src/people/page.tsx\n?? src/notes.md',
    );
  });

  it('signs off a page with no changed file with no commit', async () => {
    w = await openPassWorld();
    await turn(w.people, () => undefined);
    ready(w.people);

    expect(await signOff(w.people)).toMatchObject({ kind: 'signed_off', landedSha: null });

    expect(landed()).toEqual([]);
    expect(getWorkstreamRow(w.h.store.db, w.runOf(w.people)).state).toBe('DONE');
    expect(listTaskThread(w.h.store.db, w.people.id).at(-1)?.body).toBe(
      'Signed off · nothing to land',
    );
  });

  it.each([
    { name: 'makes no second commit', between: null, landed: ['Settings: UI work'] },
    {
      name: "lands the next turn's files as a second commit after a message",
      between: { path: 'src/settings/more.tsx', content: 'more\n' },
      landed: ['Settings: UI work', 'Settings: UI work'],
    },
  ])(
    '$name when the daemon stops between the commit and the write',
    async ({ between, landed: subjects }) => {
      w = await openPassWorld();
      await turn(w.settings, () => {
        w.write('src/settings/page.tsx', 'tidied\n');
      });
      ready(w.settings);
      const crashing: Git = {
        ...w.deps.git,
        landPaths: async (input) => {
          await w.deps.git.landPaths(input);
          throw new Error('the daemon stopped');
        },
      };
      await expect(
        signOff(w.settings, { ...w.deps, git: crashing, stopLane: stopped }),
      ).rejects.toThrow('the daemon stopped');
      expect(getWorkstreamRow(w.h.store.db, w.runOf(w.settings)).state).toBe('WAITING_HUMAN');
      if (between !== null) {
        await turn(w.settings, () => {
          w.write(between.path, between.content);
        });
        ready(w.settings);
      }

      const again = await signOff(w.settings, { ...w.restart(), stopLane: stopped });

      expect(again).toMatchObject({
        kind: 'signed_off',
        files: [between?.path ?? 'src/settings/page.tsx'],
      });
      expect(landed()).toEqual(subjects);
      if (between !== null) expect(onBranch(between.path)).toBe('more');
      expect(getWorkstreamRow(w.h.store.db, w.runOf(w.settings)).state).toBe('DONE');
    },
  );

  it('lands from the new tip once when a hand-typed git moved the branch as it landed', async () => {
    w = await openPassWorld();
    await turn(w.settings, () => {
      w.write('src/settings/page.tsx', 'tidied\n');
    });
    ready(w.settings);
    let raced = false;
    const racing: Git = {
      ...w.deps.git,
      landPaths: (input) => {
        if (raced) return w.deps.git.landPaths(input);
        raced = true;
        // The branch moves between the landing's read of its tip and its compare-and-swap.
        w.h.commit('docs/by-hand.md');
        return Promise.reject(
          new GitTrustError(w.h.repo, {
            kind: GitTrustFailure.Ref,
            ref: `refs/heads/${w.branch}`,
            reason: 'raced',
          }),
        );
      },
    };

    expect(await signOff(w.settings, { ...w.deps, git: racing, stopLane: stopped })).toMatchObject({
      kind: 'signed_off',
      files: ['src/settings/page.tsx'],
    });

    expect(landed()).toEqual(['Add docs/by-hand.md', 'Settings: UI work']);
    expect(getWorkstreamRow(w.h.store.db, w.runOf(w.settings)).state).toBe('DONE');
  });

  it.each([
    { name: 'the first page first', order: ['settings', 'people'] as const },
    { name: 'the second page first', order: ['people', 'settings'] as const },
  ])('keeps both edits of one shared file, signed off with $name', async ({ order }) => {
    w = await openPassWorld();
    await turn(
      w.settings,
      () => {
        w.write('src/shared.ts', 'shared\nsettings\n');
        w.write('src/settings/page.tsx', 'settings page\n');
      },
      true,
    );
    await turn(
      w.people,
      () => {
        w.write('src/shared.ts', 'shared\nsettings\npeople\n');
        w.write('src/people/page.tsx', 'people page\n');
      },
      true,
    );
    ready(w.settings);
    ready(w.people);

    for (const name of order) await signOff(w[name]);

    expect(onBranch('src/shared.ts')).toBe('shared\nsettings\npeople');
    expect(onBranch('src/settings/page.tsx')).toBe('settings page');
    expect(onBranch('src/people/page.tsx')).toBe('people page');
    // Each change once, in chain order, each before the first page that needs it.
    expect(landed()).toEqual(
      order[0] === 'settings'
        ? [
            'Shared change 1 of Settings: UI work',
            'Settings: UI work',
            'Shared change 2 of People: UI work',
            'People: UI work',
          ]
        : [
            'Shared change 1 of Settings: UI work',
            'Shared change 2 of People: UI work',
            'People: UI work',
            'Settings: UI work',
          ],
    );
    expect(
      listSharedChanges(w.h.store.db, w.opened.pass.id).every((c) => c.landedSha !== null),
    ).toBe(true);
  });

  it("says on an open page's thread that its change landed early with a page built on it", async () => {
    w = await openPassWorld();
    await turn(
      w.settings,
      () => {
        w.write('src/button.ts', 'button\n');
      },
      true,
    );
    await turn(w.people, () => {
      w.write('src/people/page.tsx', 'people page\n');
    });
    ready(w.people);

    await signOff(w.people);

    expect(landed()).toEqual(['Shared change 1 of Settings: UI work', 'People: UI work']);
    expect(listTaskThread(w.h.store.db, w.settings.id).at(-1)?.body).toBe(
      "Landed Settings: UI work's change to `src/button.ts` with People: UI work, which builds on it.",
    );
  });

  it('lands each shared change once when the daemon stops between two landings', async () => {
    w = await openPassWorld();
    await turn(
      w.settings,
      () => {
        w.write('src/button.ts', 'button\n');
      },
      true,
    );
    await turn(
      w.people,
      () => {
        w.write('src/card.ts', 'card\n');
        w.write('src/people/page.tsx', 'people page\n');
      },
      true,
    );
    ready(w.people);
    let calls = 0;
    const crashing: Git = {
      ...w.deps.git,
      landPaths: async (input) => {
        const done = await w.deps.git.landPaths(input);
        calls += 1;
        if (calls === 2) throw new Error('the daemon stopped');
        return done;
      },
    };
    await expect(
      signOff(w.people, { ...w.deps, git: crashing, stopLane: stopped }),
    ).rejects.toThrow('the daemon stopped');

    await signOff(w.people, { ...w.restart(), stopLane: stopped });

    expect(landed()).toEqual([
      'Shared change 1 of Settings: UI work',
      'Shared change 2 of People: UI work',
      'People: UI work',
    ]);
  });

  it("waits on a row for another page's open hold it needs, then lands that change first", async () => {
    w = await openPassWorld();
    // People's turn holds src and has written to it; Settings was built and looked at with that.
    w.startTurn(w.people);
    const granted = await grantSharedHold(w.deps, { workstreamId: w.runOf(w.people), area: 'src' });
    if (!granted?.ok) throw new Error('src was not granted');
    w.write('src/button.ts', 'button\n');
    await turn(w.settings, () => {
      w.write('src/settings/page.tsx', 'settings page\n');
    });
    ready(w.settings);

    const waiting = await signOff(w.settings);

    expect(waiting).toMatchObject({ kind: 'waiting', waitsFor: { taskId: w.people.id } });
    expect(landed()).toEqual([]);
    expect(listSignOffWaits(w.h.store.db, w.opened.pass.id)).toMatchObject([
      { taskId: w.settings.id, waitsForTaskId: w.people.id },
    ]);
    // A restart finds the row; People's turn ends and keeps its hold.
    const after = { ...w.restart(), stopLane: stopped };
    const [hold] = openHolds(after.state.db, w.opened.pass.id);
    if (!hold) throw new Error('no hold');
    await keepHold(after, { claimId: hold.claimId });

    const done = await signOffSteps(after, { taskId: w.settings.id, from: SignOffFrom.Wait });

    expect(done).toMatchObject({ kind: 'signed_off', sharedLanded: [1] });
    expect(landed()).toEqual(['Shared change 1 of People: UI work', 'Settings: UI work']);
    expect(listSignOffWaits(w.h.store.db, w.opened.pass.id)).toEqual([]);
  });

  it('is not taken when the page is no longer Ready, and the thread says so', async () => {
    w = await openPassWorld();
    await turn(w.settings, () => {
      w.write('src/settings/page.tsx', 'tidied\n');
    });

    expect(await signOff(w.settings)).toMatchObject({ kind: 'not_now' });

    expect(landed()).toEqual([]);
    expect(listTaskThread(w.h.store.db, w.settings.id).at(-1)?.body).toBe(
      'Not signed off: the page is no longer Ready.',
    );
  });
});

describe('a waiting sign-off', () => {
  afterEach(() => {
    w.close();
  });
  const takeOutDeps = () => ({ ...w.deps, stopLane: stopped, wrote: stopped });

  it.each([
    {
      name: 'a take-out of the waiting page',
      end: () => takeOut(takeOutDeps(), { taskId: w.settings.id, within: TakeOutWithin.Alone }),
    },
    { name: 'an Abandon of the pass', end: () => abandonPass(takeOutDeps(), w.opened.pass.id) },
    {
      name: 'the builder cancelling it',
      end: () => {
        cancelSignOffWait(w.deps, w.opened.pass.id, w.settings.id);
        return Promise.resolve();
      },
    },
  ])('ends with $name', async ({ end }) => {
    w = await openPassWorld();
    w.startTurn(w.people);
    const granted = await grantSharedHold(w.deps, { workstreamId: w.runOf(w.people), area: 'src' });
    if (!granted?.ok) throw new Error('src was not granted');
    w.write('src/button.ts', 'button\n');
    await turn(w.settings, () => {
      w.write('src/settings/page.tsx', 'settings page\n');
    });
    ready(w.settings);
    expect(await signOff(w.settings)).toMatchObject({ kind: 'waiting' });

    await end();

    expect(listSignOffWaits(w.h.store.db, w.opened.pass.id)).toEqual([]);
  });
});

describe('a Sign Off from the Ready card that does not land', () => {
  afterEach(() => {
    w.close();
  });

  /** Sign Off answered on the page's Ready card, as the card's write closes it. */
  function answerCard(task: TaskDto) {
    const row = getWorkstreamRow(w.h.store.db, w.runOf(task));
    if (row.nextAction.kind !== 'pass_review') throw new Error('not Ready');
    const id = row.nextAction.inboxId;
    w.h.state.write((ctx) =>
      updateInboxItem(ctx, id, {
        state: InboxState.Resolved,
        answer: { choice: PASS_SIGN_OFF_CHOICE },
      }),
    );
    return id;
  }

  it.each([
    {
      name: "fails with Your folder off the pass's branch",
      before: () => undefined,
      act: async () => {
        w.h.git$('switch', '-q', 'main');
        startSignOff({ ...w.deps, stopLane: stopped }, w.settings.id);
        await w.h.jobs.idle();
        w.h.git$('switch', '-q', w.branch);
      },
      line: /^Not signed off: .*main/,
    },
    {
      name: 'is cancelled while it waits',
      before: async () => {
        w.startTurn(w.people);
        await grantSharedHold(w.deps, { workstreamId: w.runOf(w.people), area: 'src' });
        w.write('src/button.ts', 'button\n');
      },
      act: async () => {
        startSignOff({ ...w.deps, stopLane: stopped }, w.settings.id);
        await w.h.jobs.idle();
        cancelSignOffWait(w.deps, w.opened.pass.id, w.settings.id);
      },
      line: /^Sign-off cancelled while it waited\.$/,
    },
  ])('puts the Ready card back when it $name', async ({ before, act, line }) => {
    w = await openPassWorld();
    await before();
    await turn(w.settings, () => {
      w.write('src/settings/page.tsx', 'tidied\n');
    });
    ready(w.settings);
    const card = answerCard(w.settings);

    await act();

    expect(landed()).toEqual([]);
    expect(getInboxItem(w.h.store.db, card).state).toBe('OPEN');
    expect(listTaskThread(w.h.store.db, w.settings.id).at(-1)?.body).toMatch(line);
    // The builder can sign the page off again.
    expect(signOffRefusal(w.h.store.db, w.opened.pass.id, w.settings.id)).toBeNull();
  });
});

describe('finishSignOff', () => {
  beforeAll(async () => {
    w = await openPassWorld();
  });
  afterAll(() => {
    w.close();
  });

  /** A run of a new task of the project, moved along `path` from QUEUED. */
  function runIn(path: readonly WorkstreamState[]) {
    const task = w.h.addTask(`Page in ${path.at(-1) ?? 'QUEUED'}`, { areas: ['people'] });
    return w.h.state.write((ctx) => {
      const ws = insertWorkstream(ctx, task.id, {
        batchId: w.opened.batch.id,
        first: { model: 'claude-sonnet-5-5', effort: 'medium' },
      });
      for (const to of path) transitionWorkstream(ctx, ws.id, { to, fence: null });
      return { task, ws: ws.id };
    });
  }
  const finish = (run: ReturnType<typeof runIn>) => {
    w.h.state.write((ctx) => {
      finishSignOff(ctx, {
        passId: w.opened.pass.id,
        taskId: run.task.id,
        workstreamId: run.ws,
        landedSha: null,
        files: [],
        shared: [],
        indexStale: false,
      });
    });
  };

  it.each([
    { from: 'WAITING_HUMAN', path: [S.Starting, S.Running, S.WaitingHuman] },
    { from: 'QUEUED', path: [] },
    { from: 'HELD', path: [S.Held] },
    { from: 'PAUSED_LIMIT', path: [S.Starting, S.PausedLimit] },
    { from: 'RECOVERING', path: [S.Starting, S.Recovering] },
    { from: 'STARTING', path: [S.Starting] },
    { from: 'VERIFYING', path: [S.Starting, S.Verifying] },
  ])('takes a run in $from to DONE by edges that exist', ({ path }) => {
    const run = runIn(path);
    finish(run);
    expect(getWorkstreamRow(w.h.store.db, run.ws).state).toBe('DONE');
  });

  it.each([
    { from: 'RUNNING', path: [S.Starting, S.Running] },
    { from: 'HANDING_OFF', path: [S.Starting, S.Running, S.HandingOff] },
    { from: 'TAKEN_OVER', path: [S.Starting, S.Running, S.TakenOver] },
  ])('refuses a run in $from and writes nothing', ({ from, path }) => {
    const run = runIn(path);
    expect(() => {
      finish(run);
    }).toThrow(ConflictError);
    expect(getWorkstreamRow(w.h.store.db, run.ws).state).toBe(from);
    expect(listTaskThread(w.h.store.db, run.task.id)).toEqual([]);
  });
});
