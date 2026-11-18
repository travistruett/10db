import {
  PassClosePageChoice,
  PassState,
  PullRequestChecks,
  PullRequestState,
  type ProjectInput,
} from '@10db/contracts';
import {
  getBatch,
  getPass,
  getPassProgress,
  getPassPullRequest,
  getProject,
  getTask,
  listInbox,
  hasNoticeKey,
  recordPullRequestStatus,
  setClosePlan,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { waitFor } from '../../test/fixtures';
import { openPassWorld, type PassWorld } from '../../test/pass-world';
import { PrState } from '../github';
import {
  createPassPullRequests,
  openPass,
  passGateKind,
  subscribePassSettles,
  type PassPullRequests,
} from '../delivery';
import { silentLogger } from '../log';
import { systemProcesses } from '../recovery';
import { createGateRunner } from '../verify';
import { closeSteps, createPassCloses, type CloseDeps, type PassCloses } from './close';
import { closeGateOf } from './close-lists';
import { keepTurnWork, putBackKeptWork, subscribeMergedPasses } from './index';
import { carryOverDue, followOnPush, mergedClosePlan } from './merged-open';

// Workbench spec §5.4, call 6: a pull request that merges while its pass is open closes the pass,
// with no gate and no push: its unfinished pages are taken out and carry over to a follow-on pass
// stacked on it, with the pages signed off after the last push; with none unfinished, those are
// pushed and a follow-on pull request is opened against the base.

const stopped = (): Promise<void> => Promise.resolve();

let w: PassWorld;
let prs: PassPullRequests | null = null;
let unsubscribe: () => void = () => undefined;
afterEach(async () => {
  unsubscribe();
  await prs?.stop();
  prs = null;
  w.close();
});

/** A pass whose gate would fail if it ran, with 7b's real ship over the harness's fake gh. */
async function world(
  project: Partial<ProjectInput> = { gateCommand: 'false' },
  opts: { readonly pageCap?: number } = {},
): Promise<{
  closes: PassCloses;
  deps: CloseDeps;
}> {
  w = await openPassWorld({
    project,
    ...(opts.pageCap === undefined ? {} : { pageCap: opts.pageCap }),
  });
  prs = createPassPullRequests({
    ...w.h.ctx,
    gate: createGateRunner({ sandbox: null, logger: silentLogger }),
    dataDir: w.h.dataDir,
    sessionEnv: () => ({ PATH: '/usr/bin:/bin' }),
    identifyProcess: (pid) => systemProcesses.identify(pid),
    review: null,
  });
  const deps: CloseDeps = {
    ...w.deps,
    stopLane: stopped,
    wrote: stopped,
    ship: prs,
    gateWhere: (pass) => closeGateOf(passGateKind(getProject(w.h.store.db, pass.projectId))),
    openFollowOn: (input) =>
      openPass(w.h.ctx, input, {
        leaseMs: 60_000,
        putBack: (put) => putBackKeptWork(w.deps, put),
      }),
  };
  const closes = createPassCloses(deps);
  unsubscribe = subscribeMergedPasses(w.h.bus, w.h.store.db, closes);
  return { closes, deps };
}

/** Settings is signed off: its commit is on the pass's branch and its run is done. */
function settingsSignedOff(): void {
  w.h.commit('src/settings/page.tsx', 'signed off\n');
  w.h.settle(w.runOf(w.settings), 'DONE');
}

/** The pass's branch is pushed and its pull request opened; answers its url and the pushed tip. */
async function opened(): Promise<{ url: string; pushed: string }> {
  if (prs === null) throw new Error('no ship');
  const signal = new AbortController().signal;
  await prs.pushPassBranch(w.opened.pass.id, signal);
  const pr = await prs.ensurePassPr({ passId: w.opened.pass.id, ready: false }, signal);
  if (pr === null) throw new Error('no pull request');
  return { url: pr.url, pushed: w.h.git$('rev-parse', w.branch) };
}

/** GitHub merged the pull request, and the watch read it. */
function merged(url: string): void {
  w.h.gh.setState(url, PrState.Merged);
  w.h.state.write((ctx) => {
    recordPullRequestStatus(ctx, w.opened.pass.batchId, {
      state: PullRequestState.Merged,
      checks: PullRequestChecks.Passing,
      failingChecks: [],
      checkedAt: ctx.now,
      unknownReason: null,
    });
  });
}

/** The notice a merged pass posts for its follow-on; it marks the carry-over done. */
const followOnNotice = () =>
  w.h.notices().find((n) => n.key === `pass-follow-on:${w.opened.pass.id}`);

/** No card is stored for it: the follow-on is a notice. */
const followOnCards = () =>
  listInbox(w.h.store.db, {}).filter((i) =>
    i.title.includes('closed when its pull request merged'),
  );

describe('a pull request that merges while its pass is open', () => {
  // A close, a follow-on pass's opening and a settle: room for a full run's load.
  it(
    'closes with no gate or push, and carries the unfinished page and later sign-offs to a stacked follow-on pass',
    { timeout: 120_000 },
    async () => {
      await world(undefined, { pageCap: 6 });
      settingsSignedOff();
      const { url, pushed } = await opened();
      // A page signed off after the push.
      w.h.commit('src/settings/old.tsx', 'signed off later\n');
      const tip = w.h.git$('rev-parse', w.branch);
      const turn = w.startTurn(w.people);
      w.write('src/people/page.tsx', 'people, unfinished\n');
      w.endTurn(turn);
      await keepTurnWork(w.deps, { workstreamId: w.runOf(w.people), turnId: turn.id });
      // GitHub squash-merged the pull request as pushed.
      const squash = w.h.origin$('commit-tree', '-p', 'main', '-m', 'squash', `${pushed}^{tree}`);
      w.h.origin$('update-ref', 'refs/heads/main', squash);
      const settles = subscribePassSettles(w.h.bus, w.h.ctx);

      merged(url);
      await waitFor(() => followOnNotice() !== undefined, 60_000);
      await w.h.jobs.idle();
      await waitFor(
        () => getPass(w.h.store.db, w.opened.pass.id).state === PassState.Settled,
        60_000,
      );
      await w.h.jobs.idle();
      settles();

      const db = w.h.store.db;
      const a = w.opened.pass;
      expect(getBatch(db, a.batchId).state).toBe('SHIPPED');
      // No gate ran (it would have failed and reopened the pass), and nothing was pushed again.
      expect(w.h.origin$('rev-parse', w.branch)).toBe(pushed);
      expect(w.h.gh.prCreates()).toHaveLength(1);
      // D8: the branch the folder came from holds every signed-off page.
      expect(w.h.git$('rev-parse', 'main')).toBe(tip);
      expect(followOnCards()).toEqual([]);
      expect(followOnNotice()).toMatchObject({ tone: 'info', taskId: null });
      const followOnPassId = getTask(db, w.people.id).passId;
      if (!followOnPassId) throw new Error('no follow-on pass');
      const b = getPass(db, followOnPassId);
      expect(followOnNotice()?.body).toContain(`carried over to pass "${b.name}"`);
      expect(b.state).toBe(PassState.Open);
      expect(b.startSha).toBe(tip);
      expect(getPassProgress(db, b.id).stackedOn).toBe(a.id);
      expect(b.pageCap).toBe(6);
      expect(getTask(db, w.people.id).passId).toBe(b.id);
      // The follow-on pass took the base in by a merge that changes no file: its pull request shows
      // the later sign-offs and its own pages, not the merged pass's commits.
      const head = w.h.git$('rev-parse', `refs/heads/${getBatch(db, b.batchId).branch ?? ''}`);
      expect(w.h.git$('rev-parse', `${head}^2`)).toBe(squash);
      expect(w.h.git$('rev-parse', `${head}^{tree}`)).toBe(w.h.git$('rev-parse', `${tip}^{tree}`));
      expect(getPassProgress(db, b.id).notices).toEqual([]);
      // The unfinished page's work is back in the folder, in the follow-on pass.
      expect(w.h.git$('show', `:src/people/page.tsx`)).toBe('people');
      expect(w.h.git$('diff', '--name-only')).toBe('src/people/page.tsx');
    },
  );

  it('with every page signed off, pushes the later sign-offs and opens a follow-on pull request', async () => {
    await world();
    settingsSignedOff();
    w.h.commit('src/people/page.tsx', 'people, signed off\n');
    w.h.settle(w.runOf(w.people), 'DONE');
    const { url, pushed } = await opened();
    w.h.commit('src/settings/old.tsx', 'signed off later\n');
    const tip = w.h.git$('rev-parse', w.branch);
    // GitHub squash-merged the pull request as pushed.
    const squash = w.h.origin$('commit-tree', '-p', 'main', '-m', 'squash', `${pushed}^{tree}`);
    w.h.origin$('update-ref', 'refs/heads/main', squash);

    merged(url);
    await waitFor(() => followOnNotice() !== undefined);
    await w.h.jobs.idle();

    const db = w.h.store.db;
    const a = w.opened.pass;
    expect(getPass(db, a.id).state).toBe(PassState.Closed);
    expect(getBatch(db, a.batchId).state).toBe('SHIPPED');
    // The base came into the branch by a merge that changes no file, so the follow-on pull request
    // shows only the later sign-offs; the branch, with it, is pushed.
    const head = w.h.origin$('rev-parse', w.branch);
    expect(w.h.git$('rev-parse', `${head}^1`, `${head}^2`)).toBe(`${tip}\n${squash}`);
    expect(w.h.git$('rev-parse', `${head}^{tree}`)).toBe(w.h.git$('rev-parse', `${tip}^{tree}`));
    const creates = w.h.gh.prCreates();
    expect(creates).toHaveLength(2);
    expect(creates).toContainEqual(
      expect.objectContaining({ base: 'main', head: w.branch, draft: false }),
    );
    const followOn = getPassPullRequest(db, a.id);
    expect(followOn?.url).not.toBe(url);
    expect(followOnNotice()?.body).toContain(
      `The pages signed off after the last push are in ${followOn?.url ?? ''}.`,
    );
  });

  it("closes by itself when the watch reads the merge while Close Pass's gate runs and fails", async () => {
    const { deps } = await world();
    settingsSignedOff();
    const { url } = await opened();
    const closes = createPassCloses({
      ...deps,
      ship: {
        ...deps.ship,
        gatePassTip: async (i) => {
          // The pass is closing as the watch reads the merge: only the reopened pass closes by it.
          merged(url);
          return deps.ship.gatePassTip(i);
        },
      },
    });
    unsubscribe();
    unsubscribe = subscribeMergedPasses(w.h.bus, w.h.store.db, closes);
    const shown = await closes.preview(w.opened.pass.id);

    await closes.close(w.opened.pass.id, {
      token: shown.token,
      pages: [{ taskId: w.people.id, choice: PassClosePageChoice.TakeOut }],
      files: [],
      shared: [],
    });
    await w.h.jobs.idle();
    await w.h.jobs.idle();

    expect(getPass(w.h.store.db, w.opened.pass.id).state).toBe(PassState.Closed);
    expect(followOnNotice()).toBeDefined();
  });

  it('opens the follow-on pull request after a restart cut its push short', async () => {
    const { deps } = await world();
    unsubscribe();
    settingsSignedOff();
    w.h.commit('src/people/page.tsx', 'people, signed off\n');
    w.h.settle(w.runOf(w.people), 'DONE');
    const { url } = await opened();
    w.h.commit('src/settings/old.tsx', 'signed off later\n');
    merged(url);
    const plan = mergedClosePlan(w.h.store.db, w.opened.pass.id);
    // The daemon stops just after the push reached origin.
    const stopping = new AbortController();
    const cut = createPassPullRequests({
      ...w.h.ctx,
      git: {
        ...w.h.git,
        push: async (...args) => {
          await w.h.git.push(...args);
          stopping.abort();
          throw new Error('the daemon stopped');
        },
      },
      gate: createGateRunner({ sandbox: null, logger: silentLogger }),
      dataDir: w.h.dataDir,
      sessionEnv: () => ({ PATH: '/usr/bin:/bin' }),
      identifyProcess: (pid) => systemProcesses.identify(pid),
      review: null,
    });
    await expect(
      followOnPush({ ...deps, ship: cut }, w.opened.pass.id, plan, stopping.signal),
    ).rejects.toThrow();
    await cut.stop();

    await followOnPush(deps, w.opened.pass.id, plan, new AbortController().signal);

    expect(w.h.gh.prCreates()).toHaveLength(2);
    expect(getPassPullRequest(w.h.store.db, w.opened.pass.id)?.url).not.toBe(url);
  });

  it.each([
    {
      name: 'closes an open pass whose pull request merged while 10db was stopped',
      before: () => undefined,
    },
    {
      name: 'carries over the pages of a merged close a stop cut short after it closed',
      before: async (deps: CloseDeps) => {
        w.h.state.write((ctx) => {
          setClosePlan(ctx, w.opened.pass.id, mergedClosePlan(ctx.tx, w.opened.pass.id));
        });
        await closeSteps(deps, w.opened.pass.id, new AbortController().signal);
        expect(getPass(w.h.store.db, w.opened.pass.id).state).toBe(PassState.Closed);
        // A stop cut it short: no notice and no card say the pages were carried over.
        expect(followOnNotice()).toBeUndefined();
        expect(followOnCards()).toEqual([]);
        expect(carryOverDue(w.h.store.db, w.opened.pass.id)).toBe(true);
      },
    },
  ])('at start-up, $name', async ({ before }) => {
    const { deps } = await world();
    unsubscribe();
    settingsSignedOff();
    const { url } = await opened();
    merged(url);
    await before(deps);

    createPassCloses({ ...deps, ...w.restart() }).resume();
    await waitFor(() => followOnNotice() !== undefined);
    await w.h.jobs.idle();

    const db = w.h.store.db;
    expect(getPass(db, w.opened.pass.id).state).toBe(PassState.Closed);
    expect(followOnCards()).toEqual([]);
    expect(getTask(db, w.people.id).passId).toBeTruthy();
  });

  it('carries nothing over twice: with its notice posted, a restart finds the carry-over done', async () => {
    const { deps } = await world();
    unsubscribe();
    settingsSignedOff();
    const { url } = await opened();
    merged(url);
    createPassCloses(deps).resume();
    await waitFor(() => followOnNotice() !== undefined);
    await w.h.jobs.idle();
    const db = w.h.store.db;
    const placed = getTask(db, w.people.id).passId;
    expect(carryOverDue(db, w.opened.pass.id)).toBe(false);
    expect(hasNoticeKey(db, w.opened.pass.projectId, `pass-follow-on:${w.opened.pass.id}`)).toBe(
      true,
    );

    createPassCloses({ ...deps, ...w.restart() }).resume();
    await w.h.jobs.idle();

    expect(
      w.h.notices().filter((n) => n.key === `pass-follow-on:${w.opened.pass.id}`),
    ).toHaveLength(1);
    expect(getTask(db, w.people.id).passId).toBe(placed);
  });

  it('refuses a Close Pass once merged, and closes it by itself', async () => {
    const { closes } = await world();
    settingsSignedOff();
    const { url } = await opened();
    // Read as merged with nothing following the watch, as before the close job starts.
    unsubscribe();
    w.h.gh.setState(url, PrState.Merged);
    w.h.state.write((ctx) => {
      recordPullRequestStatus(ctx, w.opened.pass.batchId, {
        state: PullRequestState.Merged,
        checks: PullRequestChecks.Passing,
        failingChecks: [],
        checkedAt: ctx.now,
        unknownReason: null,
      });
    });
    const shown = await closes.preview(w.opened.pass.id);

    await expect(
      closes.close(w.opened.pass.id, { token: shown.token, pages: [], files: [], shared: [] }),
    ).rejects.toThrow(/merged/);
    await waitFor(() => followOnNotice() !== undefined);
    expect(getPass(w.h.store.db, w.opened.pass.id).state).toBe(PassState.Closed);
  });
});
