import {
  AbandonStep,
  ConflictError,
  InboxState,
  PASS_SIGN_OFF_CHOICE,
  WorkstreamState as S,
  type TaskDto,
  type WorkstreamId,
  type WorkstreamState,
} from '@10db/contracts';
import {
  acquireClaims,
  activeClaims,
  claimRequestsForTask,
  getInboxItem,
  getProject,
  getWorkstreamRow,
  insertBuilderMessage,
  insertWorkstream,
  latestPassTurn,
  listSharedChanges,
  listSignOffWaits,
  listTaskThread,
  openHolds,
  setAbandonStep,
  setClosePlan,
  transitionWorkstream,
  updateInboxItem,
  type WriteContext,
} from '@10db/db';
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import { openPassWorld, type PassWorld } from '../../test/pass-world';
import { queueUntaken } from '../runner';
import { GitTrustError, GitTrustFailure, type Git } from '../git';
import {
  abandonPass,
  grantSharedHold,
  keepHold,
  keepTurnWork,
  startAbandon,
  takeOut,
  TakeOutWithin,
} from './index';
import { jobKey, JobQueue } from '../delivery';
import { passView } from './view';
import {
  askSignOff,
  cancelSignOffWait,
  finishSignOff,
  resumeSignOffWaits,
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
    w.ready(w.settings);

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

  it('is not taken when the page is no longer Ready, saying so, and signs off a page with no changed file with no commit', async () => {
    w = await openPassWorld();
    await turn(w.settings, () => {
      w.write('src/settings/page.tsx', 'tidied\n');
    });

    expect(await signOff(w.settings)).toMatchObject({ kind: 'not_now' });

    expect(landed()).toEqual([]);
    expect(listTaskThread(w.h.store.db, w.settings.id).at(-1)?.body).toBe(
      'Not signed off: the page is no longer Ready.',
    );

    await turn(w.people, () => undefined);
    w.ready(w.people);

    expect(await signOff(w.people)).toMatchObject({ kind: 'signed_off', landedSha: null });

    expect(landed()).toEqual([]);
    expect(getWorkstreamRow(w.h.store.db, w.runOf(w.people)).state).toBe('DONE');
    expect(listTaskThread(w.h.store.db, w.people.id).at(-1)?.body).toBe(
      'Signed off · nothing to land',
    );
  });

  it('lands each turn once when the daemon stops between the commit and the write: no second commit, or the next turn as a second commit after a message', async () => {
    const rows = [
      { name: 'makes no second commit', between: null, landed: ['Settings: UI work'] },
      {
        name: "lands the next turn's files as a second commit after a message",
        between: { path: 'src/settings/more.tsx', content: 'more\n' },
        landed: ['Settings: UI work', 'Settings: UI work'],
      },
    ];
    for (const [at, { name, between, landed: subjects }] of rows.entries()) {
      if (at > 0) w.close();
      w = await openPassWorld();
      await turn(w.settings, () => {
        w.write('src/settings/page.tsx', 'tidied\n');
      });
      w.ready(w.settings);
      const crashing: Git = {
        ...w.deps.git,
        landPaths: async (input) => {
          await w.deps.git.landPaths(input);
          throw new Error('the daemon stopped');
        },
      };
      await expect(
        signOff(w.settings, { ...w.deps, git: crashing, stopLane: stopped }),
        name,
      ).rejects.toThrow('the daemon stopped');
      expect
        .soft(getWorkstreamRow(w.h.store.db, w.runOf(w.settings)).state, name)
        .toBe('WAITING_HUMAN');
      if (between !== null) {
        await turn(w.settings, () => {
          w.write(between.path, between.content);
        });
        w.ready(w.settings);
      }

      const again = await signOff(w.settings, { ...w.restart(), stopLane: stopped });

      expect.soft(again, name).toMatchObject({
        kind: 'signed_off',
        files: [between?.path ?? 'src/settings/page.tsx'],
      });
      expect.soft(landed(), name).toEqual(subjects);
      if (between !== null) expect.soft(onBranch(between.path), name).toBe('more');
      expect.soft(getWorkstreamRow(w.h.store.db, w.runOf(w.settings)).state, name).toBe('DONE');
    }
  }, 120_000);

  it('leaves the page unsigned when a message comes as it lands, whatever its next turn does, and lands nothing when one queues the next turn as the session stops', async () => {
    const rows = [
      {
        name: 'queued its next turn',
        after: (ctx: WriteContext, ws: WorkstreamId) => queueUntaken(ctx, ws, null, null),
        state: 'QUEUED',
      },
      {
        name: 'started its next turn',
        after: (ctx: WriteContext, ws: WorkstreamId) => {
          transitionWorkstream(ctx, ws, { to: S.Running, fence: null });
        },
        state: 'RUNNING',
      },
      { name: 'waits for its next turn', after: () => undefined, state: 'WAITING_HUMAN' },
    ];
    for (const [at, { name, after, state }] of rows.entries()) {
      if (at > 0) w.close();
      w = await openPassWorld();
      await turn(w.settings, () => {
        w.write('src/settings/page.tsx', 'tidied\n');
      });
      w.ready(w.settings);
      const ws = w.runOf(w.settings);
      const messaged: Git = {
        ...w.deps.git,
        landPaths: async (input) => {
          const done = await w.deps.git.landPaths(input);
          w.h.state.write((ctx) => {
            insertBuilderMessage(ctx, w.settings.id, { body: 'one more thing', files: [] });
            after(ctx, ws);
          });
          return done;
        },
      };

      const outcome = await signOff(w.settings, { ...w.deps, git: messaged, stopLane: stopped });

      expect.soft(outcome, name).toMatchObject({ kind: 'not_now' });
      // The commit stays on the branch; the next sign-off lands what the turn adds.
      expect.soft(landed(), name).toEqual(['Settings: UI work']);
      expect.soft(getWorkstreamRow(w.h.store.db, ws).state, name).toBe(state);
      expect
        .soft(listTaskThread(w.h.store.db, w.settings.id).at(-1)?.body, name)
        .toMatch(/^Not signed off: the page took a message as it landed/);
    }

    // A message that queues the next turn as the session stops: nothing lands.
    const label = 'a message as the session stops';
    w.close();
    w = await openPassWorld();
    await turn(w.settings, () => {
      w.write('src/settings/page.tsx', 'tidied\n');
    });
    w.ready(w.settings);
    const ws = w.runOf(w.settings);

    const outcome = await signOff(w.settings, {
      ...w.deps,
      stopLane: () => {
        w.h.state.write((ctx) => {
          insertBuilderMessage(ctx, w.settings.id, { body: 'one more thing', files: [] });
          queueUntaken(ctx, ws, null, null);
        });
        return Promise.resolve();
      },
    });

    expect.soft(outcome, label).toMatchObject({ kind: 'not_now' });
    expect.soft(landed(), label).toEqual([]);
    expect.soft(getWorkstreamRow(w.h.store.db, ws).state, label).toBe('QUEUED');
    expect
      .soft(listTaskThread(w.h.store.db, w.settings.id).at(-1)?.body, label)
      .toBe('Not signed off: the page took a message as its session stopped.');
  }, 240_000);

  it("ends no run once an Abandon took the pass as it landed, of a page or of a close's Sign Off Now", async () => {
    const rows = [
      { name: 'a page', from: SignOffFrom.Page, closing: false },
      { name: "a close's Sign Off Now", from: SignOffFrom.Close, closing: true },
    ];
    for (const [at, { name, from, closing }] of rows.entries()) {
      if (at > 0) w.close();
      w = await openPassWorld();
      await turn(w.settings, () => {
        w.write('src/settings/page.tsx', 'tidied\n');
      });
      w.ready(w.settings);
      if (closing)
        w.h.state.write((ctx) => {
          setClosePlan(ctx, w.opened.pass.id, { token: 't', pages: [], files: [], shared: [] });
        });
      const abandoned: Git = {
        ...w.deps.git,
        landPaths: async (input) => {
          const done = await w.deps.git.landPaths(input);
          w.h.state.write((ctx) => {
            setAbandonStep(ctx, w.opened.pass.id, AbandonStep.Abandoning);
          });
          return done;
        },
      };

      const signing = signOffSteps(
        { ...w.deps, git: abandoned, stopLane: stopped },
        { taskId: w.settings.id, from },
      );

      if (closing) await expect.soft(signing, name).rejects.toThrow(ConflictError);
      else expect.soft(await signing, name).toMatchObject({ kind: 'not_now' });
      expect
        .soft(getWorkstreamRow(w.h.store.db, w.runOf(w.settings)).state, name)
        .toBe('WAITING_HUMAN');
    }
  }, 120_000);

  it('lands from the new tip once when a hand-typed git moved the branch as it landed', async () => {
    w = await openPassWorld();
    await turn(w.settings, () => {
      w.write('src/settings/page.tsx', 'tidied\n');
    });
    w.ready(w.settings);
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

  it('keeps both edits of one shared file, signed off with the first page first or the second', async () => {
    const rows = [
      { name: 'the first page first', order: ['settings', 'people'] as const },
      { name: 'the second page first', order: ['people', 'settings'] as const },
    ];
    for (const [at, { name, order }] of rows.entries()) {
      if (at > 0) w.close();
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
      w.ready(w.settings);
      w.ready(w.people);

      for (const page of order) await signOff(w[page]);

      expect.soft(onBranch('src/shared.ts'), name).toBe('shared\nsettings\npeople');
      expect.soft(onBranch('src/settings/page.tsx'), name).toBe('settings page');
      expect.soft(onBranch('src/people/page.tsx'), name).toBe('people page');
      // Each change once, in chain order, each before the first page that needs it.
      expect
        .soft(landed(), name)
        .toEqual(
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
      expect
        .soft(
          listSharedChanges(w.h.store.db, w.opened.pass.id).every((c) => c.landedSha !== null),
          name,
        )
        .toBe(true);
    }
  }, 120_000);

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
    w.ready(w.people);
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
    w.ready(w.settings);

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
});

describe('a waiting sign-off', () => {
  afterEach(() => {
    w.close();
  });
  const takeOutDeps = () => ({ ...w.deps, stopLane: stopped, wrote: stopped });

  const ENDS = [
    {
      name: 'a take-out of the waiting page',
      end: () => takeOut(takeOutDeps(), { taskId: w.settings.id, within: TakeOutWithin.Alone }),
    },
    { name: 'an Abandon of the pass', end: () => abandonPass(takeOutDeps(), w.opened.pass.id) },
    {
      name: "an Abandon from its route, at the Abandon's first step",
      end: async () => {
        let waits = -1;
        await startAbandon(
          {
            ...takeOutDeps(),
            // Called just after step 1's write, before any page is taken out.
            stopShip: () => {
              waits = listSignOffWaits(w.h.store.db, w.opened.pass.id).length;
              return Promise.resolve();
            },
          },
          w.opened.pass.id,
        );
        expect.soft(waits, "an Abandon from its route, at the Abandon's first step").toBe(0);
      },
    },
    {
      name: 'the builder cancelling it',
      end: () => {
        cancelSignOffWait(w.deps, w.opened.pass.id, w.settings.id);
        return Promise.resolve();
      },
    },
  ];

  it('ends with a take-out of the waiting page, an Abandon of the pass or from its route, or the builder cancelling it', async () => {
    for (const [at, { name, end }] of ENDS.entries()) {
      if (at > 0) w.close();
      w = await openPassWorld();
      w.startTurn(w.people);
      const granted = await grantSharedHold(w.deps, {
        workstreamId: w.runOf(w.people),
        area: 'src',
      });
      if (!granted?.ok) throw new Error('src was not granted');
      w.write('src/button.ts', 'button\n');
      await turn(w.settings, () => {
        w.write('src/settings/page.tsx', 'settings page\n');
      });
      w.ready(w.settings);
      expect(await signOff(w.settings), name).toMatchObject({ kind: 'waiting' });

      await end();

      expect.soft(listSignOffWaits(w.h.store.db, w.opened.pass.id), name).toEqual([]);
    }
  }, 240_000);
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

  it("puts the Ready card back when it fails with Your folder off the pass's branch", async () => {
    w = await openPassWorld();
    await turn(w.settings, () => {
      w.write('src/settings/page.tsx', 'tidied\n');
    });
    w.ready(w.settings);
    const card = answerCard(w.settings);

    w.h.git$('switch', '-q', 'main');
    startSignOff({ ...w.deps, stopLane: stopped }, w.settings.id);
    await w.h.jobs.idle();
    w.h.git$('switch', '-q', w.branch);

    expect(landed()).toEqual([]);
    expect(getInboxItem(w.h.store.db, card).state).toBe('OPEN');
    expect(listTaskThread(w.h.store.db, w.settings.id).at(-1)?.body).toMatch(
      /^Not signed off: .*main/,
    );
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

  it('takes a run in any state a sign-off can end to DONE by edges that exist', () => {
    for (const { from, path } of [
      { from: 'WAITING_HUMAN', path: [S.Starting, S.Running, S.WaitingHuman] },
      { from: 'QUEUED', path: [] },
      { from: 'HELD', path: [S.Held] },
      { from: 'PAUSED_LIMIT', path: [S.Starting, S.PausedLimit] },
      { from: 'RECOVERING', path: [S.Starting, S.Recovering] },
      { from: 'STARTING', path: [S.Starting] },
      { from: 'VERIFYING', path: [S.Starting, S.Verifying] },
    ]) {
      const run = runIn(path);
      finish(run);
      expect.soft(getWorkstreamRow(w.h.store.db, run.ws).state, from).toBe('DONE');
    }
  });

  it('refuses a run whose session is live or taken over, and writes nothing', () => {
    for (const { from, path } of [
      { from: 'RUNNING', path: [S.Starting, S.Running] },
      { from: 'HANDING_OFF', path: [S.Starting, S.Running, S.HandingOff] },
      { from: 'TAKEN_OVER', path: [S.Starting, S.Running, S.TakenOver] },
    ]) {
      const run = runIn(path);
      expect
        .soft(() => {
          finish(run);
        }, from)
        .toThrow(ConflictError);
      expect.soft(getWorkstreamRow(w.h.store.db, run.ws).state, from).toBe(from);
      expect.soft(listTaskThread(w.h.store.db, run.task.id), from).toEqual([]);
    }
  });
});

describe('a Sign Off in flight', () => {
  afterEach(() => {
    w.close();
  });

  /** Holds the project's delivery queue until the answer is called, so a sign-off stays in flight. */
  function holdQueue(): () => void {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    w.h.jobs.run(
      jobKey({ projectId: w.h.project.id, worktreePath: null }, JobQueue.Cut),
      () => held,
    );
    return release;
  }
  const pageOf = (task: TaskDto) =>
    passView(w.h.store.db, w.opened.pass.id).pages.find((p) => p.taskId === task.id);

  it('reads Signing off on the page, refuses a second Sign Off until it lands, and goes on with it after a restart cut it short', async () => {
    w = await openPassWorld();
    await turn(w.settings, () => {
      w.write('src/settings/page.tsx', 'tidied\n');
    });
    w.ready(w.settings);
    const release = holdQueue();
    const deps = { ...w.deps, stopLane: stopped };

    expect(askSignOff(deps, w.opened.pass.id, w.settings.id).state).toBe('signing_off');
    expect(pageOf(w.settings)?.signOff).toBe('signing_off');
    expect(() => askSignOff(deps, w.opened.pass.id, w.settings.id)).toThrow(ConflictError);

    const after = { ...w.restart(), stopLane: stopped };
    resumeSignOffWaits(after);
    await after.jobs.idle();

    expect(getWorkstreamRow(w.h.store.db, w.runOf(w.settings)).state).toBe('DONE');
    expect(pageOf(w.settings)?.signOff).toBe('done');
    release();
    await w.h.jobs.idle();
    expect(landed()).toEqual(['Settings: UI work']);
  });
});
