import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  PassGateState,
  PassNoticeKind,
  type PassId,
  type ScreenKind,
  type ProjectInput,
  type TaskDto,
} from '@10db/contracts';
import { AbandonStep } from '@10db/contracts';
import {
  abandonPassAndBatch,
  getAppSetting,
  setAbandonStep,
  getBatch,
  getBatchRow,
  patchProject,
  recordPullRequestStatus,
  patchBatch,
  getPass,
  getPassChecks,
  getPassProgress,
  getPassPullRequest,
  getTask,
  insertTaskScreen,
  setTaskStatus,
} from '@10db/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { silentLogger } from '../log';
import { systemProcesses } from '../recovery';
import type { Git } from '../git';
import { PrState } from '../github';
import { createGateRunner } from '../verify';
import { createSlackClient } from '../slack';
import { ManualClock } from '../clock';
import { SANDBOXED, waitFor } from '../../test/fixtures';
import { alive, orphanGateGroup } from '../../test/orphan-gate';
import { openPass, recoverBatches, type PutBackKeptWork } from './index';
import { createPassChecks } from './pass-checks';
import { createPassPullRequests, type PassPullRequests } from './pass-pr';
import {
  createSlackPicturePost,
  type SlackPicturePost,
  type SlackPicturePostDeps,
} from './slack-picture-post';
import type { PassReviewDeps } from './pass-review';
import { scratchBranchName } from './scratch-gate';
import { worktreeLockReason } from './worktree-cut';
import { madeWorktreeRoot, worktreePathFor } from './worktree-path';

// Workbench spec §5.5, §8.3, W6, W8: Open Pull Request pushes the pass's branch and opens a draft on
// any delivery; the gate then reads the pushed commit in a scratch worktree, never the folder.

const PAGES: Partial<ProjectInput> = {
  areas: [
    { name: 'settings', globs: ['src/settings/**'], role: 'page', route: '/settings' },
    { name: 'people', globs: ['src/people/**'], role: 'page', route: '/people' },
  ],
};

/** Passes only where the people page is as committed: never in the folder, where it is open. */
const GATE = 'test "$(cat src/people/page.tsx)" = people';

const nothingKept: PutBackKeptWork = () => Promise.resolve({ applied: [], left: [] });

let h: DeliveryHarness;
let prs: PassPullRequests;
let poster: SlackPicturePost | null;
/** A second `createPassPullRequests` over the same deps, as a restarted daemon makes. */
let restarted: () => PassPullRequests;
afterEach(async () => {
  await prs.stop();
  h.close();
});

function setup(
  project: Partial<ProjectInput> = {},
  opts: {
    holdShips?: () => boolean;
    review?: PassReviewDeps;
    wrapGit?: (git: Git) => Git;
    slack?: Pick<SlackPicturePostDeps, 'channelOf' | 'clientFor'>;
  } = {},
) {
  h = createDeliveryHarness(
    { ...PAGES, gateCommand: GATE, ...project },
    opts.wrapGit ? { wrapGit: opts.wrapGit } : {},
  );
  poster = opts.slack
    ? createSlackPicturePost({
        state: h.ctx.state,
        inbox: h.ctx.inbox,
        logger: silentLogger,
        ...opts.slack,
      })
    : null;
  const deps = {
    ...h.ctx,
    gate: createGateRunner({ sandbox: null, logger: silentLogger }),
    dataDir: h.dataDir,
    sessionEnv: () => ({ PATH: '/usr/bin:/bin' }),
    identifyProcess: (pid: number) => systemProcesses.identify(pid),
    review: opts.review ?? null,
    ...(poster ? { slack: poster } : {}),
    ...(opts.holdShips ? { holdShips: opts.holdShips } : {}),
  };
  prs = createPassPullRequests(deps);
  restarted = () => createPassPullRequests(deps);
  h.commit('src/settings/page.tsx', 'settings\n');
  h.commit('src/people/page.tsx', 'people\n');
  h.git$('push', '-q', 'origin', 'main');
}

function write(path: string, content: string): void {
  const file = join(h.repo, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

async function openedPass(): Promise<{ passId: PassId; settings: TaskDto; people: TaskDto }> {
  const settings = h.addTask('Settings page', { areas: ['settings'] });
  const people = h.addTask('People page', { areas: ['people'] });
  const opened = await openPass(
    h.ctx,
    { projectId: h.project.id, name: 'Polish pages', taskIds: [settings.id, people.id] },
    { leaseMs: 60_000, putBack: nothingKept },
  );
  return { passId: opened.pass.id, settings, people };
}

/** Signs a page off as its sign-off will: one commit on the pass's branch, its run done. */
function signOff(task: TaskDto, path: string, content: string): string {
  const sha = h.commit(path, content);
  const run = getTask(h.store.db, task.id).workstreamId;
  if (run === null) throw new Error('the task has no run');
  h.settle(run, 'DONE');
  return sha;
}

/** A picture of the page's route, its file written as the pictures service writes one. */
function picture(task: TaskDto, kind: ScreenKind, route: string, content: string): void {
  const storedPath = join(h.dataDir, `${task.id}-${kind}.png`);
  writeFileSync(storedPath, content);
  h.state.write((w) =>
    insertTaskScreen(w, {
      taskId: task.id,
      turnId: null,
      kind,
      route,
      viewport: { width: 1440, height: 900 },
      theme: 'default',
      sha256: createHash('sha256').update(content).digest('hex'),
      size: content.length,
      width: 1440,
      height: 900,
      storedPath,
      keptSha: null,
    }),
  );
}

const gateState = (passId: PassId) => getPassChecks(h.store.db, passId).gate.state;
const batchOf = (passId: PassId) => getPass(h.store.db, passId).batchId;

describe('Open Pull Request', () => {
  it('is not offered before a page is signed off, nor with no origin', async () => {
    setup();
    const { passId, settings, people } = await openedPass();

    expect(await prs.preview(passId)).toMatchObject({
      offered: false,
      reason: expect.stringContaining('Commit a page first') as unknown,
      base: 'main',
      existing: null,
      gate: 'scratch',
    });
    await expect(prs.open(passId, { ready: false })).rejects.toMatchObject({
      name: 'ConflictError',
    });

    // A page signed off with no change of its own lands no commit: the reason says so, not that
    // nothing is signed off.
    const run = getTask(h.store.db, people.id).workstreamId;
    if (run === null) throw new Error('the task has no run');
    h.settle(run, 'DONE');
    expect(await prs.preview(passId)).toMatchObject({
      offered: false,
      reason: 'The committed pages changed no file, so there is nothing to put in a pull request',
    });

    signOff(settings, 'src/settings/page.tsx', 'signed off\n');
    h.git$('remote', 'remove', 'origin');
    expect(await prs.preview(passId)).toMatchObject({
      offered: false,
      reason: expect.stringContaining('no GitHub remote') as unknown,
    });
    expect(h.gh.calls.filter((c) => c.method === 'prCreate')).toEqual([]);
  });

  it('pushes a committed page to the pull request once there is one, and opens none by itself', async () => {
    setup({ gateCommand: null });
    const { passId, settings, people } = await openedPass();
    signOff(settings, 'src/settings/page.tsx', 'signed off\n');
    await prs.pushCommitted(passId);
    await h.jobs.idle();
    expect(h.gh.prCreates()).toEqual([]);
    const branch = getBatch(h.store.db, batchOf(passId)).branch ?? '';
    expect(h.origin$('for-each-ref', `refs/heads/${branch}`)).toBe('');

    await prs.open(passId, { ready: false });
    await h.jobs.idle();
    const tip = signOff(people, 'src/people/page.tsx', 'people, committed\n');
    await prs.pushCommitted(passId);
    await h.jobs.idle();

    expect(h.origin$('rev-parse', `refs/heads/${branch}`)).toBe(tip);
    expect(h.gh.prCreates()).toHaveLength(1);
  });

  it("is not offered once the pass's pull request has merged", async () => {
    setup({ gateCommand: null });
    const { passId, settings } = await openedPass();
    signOff(settings, 'src/settings/page.tsx', 'signed off\n');
    await prs.open(passId, { ready: false });
    await h.jobs.idle();
    h.state.write((w) =>
      recordPullRequestStatus(w, batchOf(passId), {
        state: 'merged',
        checks: 'none',
        failingChecks: [],
        checkedAt: w.now,
        unknownReason: null,
      }),
    );

    expect(await prs.preview(passId)).toMatchObject({
      offered: false,
      reason: expect.stringContaining('merged') as unknown,
    });
  });

  it('pushes the branch and opens a draft, gates the pushed commit in a scratch worktree, never the open page on disk, writes no running gate after a restart, and pushes to the pull request it already has', async () => {
    setup();
    const { passId, settings, people } = await openedPass();
    const tip = signOff(settings, 'src/settings/page.tsx', 'signed off\n');
    // The people page is still open: its file on disk is not what the branch holds.
    write('src/people/page.tsx', 'half done\n');

    const preview = await prs.preview(passId);
    expect(preview).toMatchObject({ offered: true, reason: null, base: 'main', aheadOfBase: 0 });
    const answer = await prs.open(passId, { ready: false });
    expect(answer).toEqual({ url: null, base: 'main', gate: 'scratch', review: 'none' });
    await h.jobs.idle();

    const branch = getBatch(h.store.db, batchOf(passId)).branch ?? '';
    expect(h.origin$('rev-parse', `refs/heads/${branch}`)).toBe(tip);
    expect(h.gh.prCreates()).toEqual([
      {
        repo: 'acme/widgets',
        base: 'main',
        head: branch,
        title: 'feat(app): polish pages',
        draft: true,
      },
    ]);
    await vi.waitFor(
      () => {
        expect(gateState(passId)).toBe(PassGateState.Passed);
      },
      { timeout: 20_000 },
    );
    const pr = getPassPullRequest(h.store.db, passId);
    expect(pr).toMatchObject({ draft: true });
    await vi.waitFor(
      () => {
        expect(h.gh.body(pr?.url ?? '')).toContain('Gate passed in a scratch worktree');
      },
      { timeout: 20_000 },
    );
    expect(h.gh.body(pr?.url ?? '')).toContain('- Settings page');
    expect(h.gh.body(pr?.url ?? '')).not.toContain('People page');
    // The scratch worktree and its branch are gone; the folder is as the builder left it.
    expect(h.git$('worktree', 'list')).not.toContain('gate-');
    expect(h.git$('branch', '--list', scratchBranchName(passId))).toBe('');
    expect(h.git$('rev-parse', '--abbrev-ref', 'HEAD')).toBe(branch);
    expect(h.git$('status', '--porcelain')).toBe('M src/people/page.tsx');

    // The restarted daemon knows nothing of the gate it ran, and starts none: the close marks it ready.
    const url = pr?.url ?? '';
    await restarted().ensurePassPr({ passId, ready: true }, new AbortController().signal);
    expect(h.gh.body(url)).not.toContain('Gate running');
    expect(h.gh.body(url)).toContain('Gate result unknown');

    // A second Open Pull Request pushes to the pull request it has, rewriting its body.
    const next = signOff(people, 'src/people/page.tsx', 'people\n// signed\n');
    expect(await prs.open(passId, { ready: false })).toMatchObject({ url });
    await h.jobs.idle();
    expect(h.origin$('rev-parse', `refs/heads/${branch}`)).toBe(next);
    expect(h.gh.prCreates()).toHaveLength(1);
    expect(h.gh.body(url)).toContain('- People page');
  });

  it('shows the signed-off pages’ before and after, from a pictures branch, with the setting on, and pushes and shows none with it off', async () => {
    // The setting is the project's: one harness each.
    for (const [i, on] of [true, false].entries()) {
      if (i > 0) {
        await prs.stop();
        h.close();
      }
      const label = on ? 'setting on' : 'setting off';
      setup({ prPictures: on });
      const { passId, settings, people } = await openedPass();
      picture(settings, 'before', '/settings', 'settings before');
      picture(settings, 'after', '/settings', 'settings after');
      // People is not signed off, so its picture stays out.
      picture(people, 'before', '/people', 'people before');
      signOff(settings, 'src/settings/page.tsx', 'signed off\n');
      await prs.open(passId, { ready: false });
      await h.jobs.idle();
      const body = h.gh.body(getPassPullRequest(h.store.db, passId)?.url ?? '');
      if (!on) {
        expect.soft(h.origin$('branch', '--list', '10db-pictures/*'), label).toBe('');
        expect.soft(body, label).not.toContain('## Pictures');
        continue;
      }
      const pictures = h.origin$('rev-parse', `refs/heads/10db-pictures/${passId}`);
      expect
        .soft(h.origin$('ls-tree', '--name-only', pictures), label)
        .toBe('1-settings-after.png\n1-settings-before.png');
      expect
        .soft(h.origin$('cat-file', 'blob', `${pictures}:1-settings-after.png`), label)
        .toBe('settings after');
      expect
        .soft(h.origin$('show', '-s', '--format=%ae', pictures), label)
        .toBe('583231+octocat@users.noreply.github.com');
      expect.soft(body, label).toContain('## Pictures');
      expect
        .soft(body, label)
        .toContain(
          `![Before](https://github.com/acme/widgets/blob/${pictures}/1-settings-before.png?raw=true)`,
        );
    }
  });

  it('opens a follow-on pull request when GitHub merged the one it has before the watch read it', async () => {
    setup();
    const { passId, settings, people } = await openedPass();
    signOff(settings, 'src/settings/page.tsx', 'signed off\n');
    const signal = new AbortController().signal;
    await prs.pushPassBranch(passId, signal);
    const first = await prs.ensurePassPr({ passId, ready: false }, signal);
    if (first === null) throw new Error('no pull request');
    h.gh.setState(first.url, PrState.Merged);
    signOff(people, 'src/people/page.tsx', 'people\n// signed\n');

    await prs.pushPassBranch(passId, signal);
    const next = await prs.ensurePassPr({ passId, ready: true }, signal);

    expect(next?.url).not.toBe(first.url);
    expect(getPassPullRequest(h.store.db, passId)?.url).toBe(next?.url);
    expect(h.gh.prCreates()).toHaveLength(2);
    // The merged pull request is neither edited nor marked ready: its branch's new commits are in no
    // pull request but the follow-on.
    expect(
      h.gh.calls.filter(
        (c) =>
          (c.method === 'prReady' || c.method === 'prEditBody') &&
          JSON.stringify(c.args).includes(first.url),
      ),
    ).toEqual([]);
  });

  it('opens no follow-on when GitHub merged the pull request as pushed, with nothing signed off since', async () => {
    setup();
    const { passId, settings } = await openedPass();
    signOff(settings, 'src/settings/page.tsx', 'signed off\n');
    const signal = new AbortController().signal;
    await prs.pushPassBranch(passId, signal);
    const first = await prs.ensurePassPr({ passId, ready: false }, signal);
    if (first === null) throw new Error('no pull request');
    const branch = getBatch(h.store.db, batchOf(passId)).branch ?? '';
    // GitHub squash-merged it as pushed, before the watch read it.
    const squash = h.origin$('commit-tree', '-p', 'main', '-m', 'squash', `${branch}^{tree}`);
    h.origin$('update-ref', 'refs/heads/main', squash);
    h.gh.setState(first.url, PrState.Merged);

    await prs.pushPassBranch(passId, signal);
    const again = await prs.ensurePassPr({ passId, ready: true }, signal);

    expect(again?.url).toBe(first.url);
    expect(h.gh.prCreates()).toHaveLength(1);
    expect(getPassPullRequest(h.store.db, passId)?.url).toBe(first.url);
  });

  it('marks a failed gate in the header and the body, and the batch stays open', async () => {
    setup({ gateCommand: 'echo broken; exit 3' });
    const { passId, settings } = await openedPass();
    signOff(settings, 'src/settings/page.tsx', 'signed off\n');

    await prs.open(passId, { ready: false });
    await h.jobs.idle();

    await vi.waitFor(
      () => {
        expect(gateState(passId)).toBe(PassGateState.Failed);
      },
      { timeout: 20_000 },
    );
    const url = getPassPullRequest(h.store.db, passId)?.url ?? '';
    await vi.waitFor(
      () => {
        expect(h.gh.body(url)).toContain('Gate failed in a scratch worktree');
      },
      { timeout: 20_000 },
    );
    expect(getPassProgress(h.store.db, passId).notices).toEqual([
      expect.objectContaining({ id: 'gate', kind: PassNoticeKind.GateFailed, sendable: true }),
    ]);
    expect(getBatch(h.store.db, batchOf(passId)).state).toBe('OPEN');
  });

  it('opens no pull request and starts no gate for a pass abandoned while its branch was pushed, nor any check once it is no longer open', async () => {
    let abandon: () => void = () => undefined;
    setup(
      {},
      {
        wrapGit: (git) => ({
          ...git,
          push: async (repo, branch, net) => {
            const run = await git.push(repo, branch, net);
            abandon();
            return run;
          },
        }),
      },
    );
    const { passId, settings } = await openedPass();
    signOff(settings, 'src/settings/page.tsx', 'signed off\n');
    abandon = () => {
      h.state.write((w) => {
        setAbandonStep(w, passId, AbandonStep.Abandoning);
      });
    };

    await prs.open(passId, { ready: false });
    await h.jobs.idle();
    await prs.stopPassChecks(passId);

    expect(h.gh.prCreates()).toEqual([]);
    expect(h.logs.lines().filter((l) => l['msg'] === 'gate started')).toEqual([]);

    // Checks started by hand for the pass, now abandoning, run nothing either.
    const gated: string[] = [];
    const checks = createPassChecks({
      ...h.ctx,
      gate: ({ sha }) => {
        gated.push(sha);
        return Promise.resolve();
      },
      review: null,
      reviewed: () => Promise.resolve(),
    });

    checks.start({ passId, sha: 'a'.repeat(40), gate: true, review: false, baseRef: null });
    await checks.stop(passId);

    expect(gated).toEqual([]);
  });

  it('logs, and leaves nothing unhandled, when what follows a review fails', async () => {
    setup({ gateCommand: null });
    // A pass review needs a review step: Standard runs Build and Review.
    h.state.write((w) => patchProject(w, h.project.id, { defaultRigor: 'standard' }));
    const { passId, settings } = await openedPass();
    const tip = signOff(settings, 'src/settings/page.tsx', 'signed off\n');
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const checks = createPassChecks({
        ...h.ctx,
        gate: null,
        review: {
          adapter: { complete: () => Promise.resolve('No findings.') },
          launch: (_account, model) => ({ model, env: {}, expect: { kind: 'any' } as never }),
          scratchRoot: tmpdir(),
        },
        reviewed: () => Promise.reject(new Error('the body file could not be written')),
      });

      checks.start({ passId, sha: tip, gate: false, review: true, baseRef: null });
      await vi.waitFor(
        () => {
          expect(h.logs.lines()).toContainEqual(
            expect.objectContaining({
              msg: 'pass pull request body not updated',
              err: 'the body file could not be written',
            }),
          );
        },
        { timeout: 20_000 },
      );
      await checks.stop(passId);
      // An unhandled rejection is reported on a later turn of the event loop.
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      expect(getPassProgress(h.store.db, passId).reviewedSha).toBe(tip);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('opens a draft on a local project too, its gate not run until the close', async () => {
    setup({ delivery: 'local' });
    const { passId, settings } = await openedPass();
    signOff(settings, 'src/settings/page.tsx', 'signed off\n');

    expect(await prs.open(passId, { ready: false })).toMatchObject({ gate: 'folder_at_close' });
    await h.jobs.idle();

    const url = getPassPullRequest(h.store.db, passId)?.url ?? '';
    expect(h.gh.prCreates()).toEqual([expect.objectContaining({ draft: true, base: 'main' })]);
    expect(h.gh.body(url)).toContain('Gate not run: pages are still open in the folder');
    expect(getBatchRow(h.store.db, batchOf(passId)).gateExitCode).toBeNull();
  });

  it('starts no gate while an update drains the factory', async () => {
    setup({}, { holdShips: () => true });
    const { passId, settings } = await openedPass();
    signOff(settings, 'src/settings/page.tsx', 'signed off\n');

    await prs.open(passId, { ready: false });
    await h.jobs.idle();

    await vi.waitFor(
      () => {
        expect(h.logs.lines()).toContainEqual(
          expect.objectContaining({ msg: 'gate finished', aborted: true }),
        );
      },
      { timeout: 20_000 },
    );
    expect(h.gh.prCreates()).toHaveLength(1);
    expect(gateState(passId)).toBe(PassGateState.NotRun);
    await vi.waitFor(
      () => {
        expect(h.git$('worktree', 'list')).not.toContain('gate-');
      },
      { timeout: 20_000 },
    );
    // The body says the gate did not run, not that it is running.
    const url = getPassPullRequest(h.store.db, passId)?.url ?? '';
    await vi.waitFor(
      () => {
        expect(h.gh.body(url)).toContain('Gate not run');
      },
      { timeout: 20_000 },
    );
    expect(h.gh.body(url)).not.toContain('Gate running');
  });

  it('reviews the tip it pushed, not the one asked for', async () => {
    const asked: string[] = [];
    setup(
      { gateCommand: null },
      {
        review: {
          adapter: {
            complete: (ask) => {
              asked.push(ask.prompt);
              return Promise.resolve('No findings.');
            },
          },
          launch: (_account, model) => ({ model, env: {}, expect: { kind: 'any' } as never }),
          scratchRoot: tmpdir(),
        },
      },
    );
    // A pass review needs a review step: Standard runs Build and Review.
    h.state.write((w) => patchProject(w, h.project.id, { defaultRigor: 'standard' }));
    const { passId, settings, people } = await openedPass();
    signOff(settings, 'src/settings/page.tsx', 'signed off\n');
    await prs.open(passId, { ready: false });
    await h.jobs.idle();
    await vi.waitFor(
      () => {
        expect(asked).toHaveLength(1);
      },
      { timeout: 20_000 },
    );

    // Asked with the tip already reviewed, a page lands before the push: the push's tip is new.
    expect(await prs.open(passId, { ready: false })).toMatchObject({ review: 'unchanged' });
    const tip = signOff(people, 'src/people/page.tsx', 'people, signed\n');
    await h.jobs.idle();

    await vi.waitFor(
      () => {
        expect(getPassProgress(h.store.db, passId).reviewedSha).toBe(tip);
      },
      { timeout: 20_000 },
    );
    expect(asked).toHaveLength(2);
  });
});

describe('a restart during an Open Pull Request gate', () => {
  // Identifies the process with `ps`, which is setuid: no sandbox can run it.
  it.skipIf(SANDBOXED)(
    "reaps the gate the pass's open or abandoned batch recorded and removes the scratch worktree and branch it left",
    async () => {
      // Each case is its own killed daemon's leftovers: one harness each.
      for (const [i, { name, abandoned }] of [
        { name: 'open', abandoned: false },
        // An Abandon start-up went on with before recovery: the batch is ABANDONED by then.
        { name: 'abandoned', abandoned: true },
      ].entries()) {
        if (i > 0) {
          await prs.stop();
          h.close();
        }
        await reapsTheGate(name, abandoned);
      }
    },
  );
});

describe('Pictures to Slack', () => {
  it('posts a pass’s pictures to its Slack channel once per pull request, joins a public channel, and tries again at the next push after a refusal', async () => {
    const slack = fakeSlack();
    const client = createSlackClient({
      fetch: slack.fetch,
      token: () => Promise.resolve('xoxb-test'),
      clock: new ManualClock(),
      timeoutMs: 5_000,
    });
    // Setting off: the channel is null, so nothing is uploaded.
    let channel: { teamId: string; channelId: string; enabledAt: string | null } | null = null;
    setup({}, { slack: { channelOf: () => channel, clientFor: () => client } });
    const { passId, settings, people } = await openedPass();
    picture(settings, 'before', '/settings', 'settings before');
    picture(settings, 'after', '/settings', 'settings after');
    signOff(settings, 'src/settings/page.tsx', 'signed off\n');
    const signal = new AbortController().signal;
    const push = async () => {
      await prs.pushPassBranch(passId, signal);
      return prs.ensurePassPr({ passId, ready: false }, signal);
    };
    const off = await push();
    await h.jobs.idle();
    expect(slack.uploads).toHaveLength(0);

    // On, with the join refused: nothing is uploaded and one Inbox item says why.
    channel = { teamId: 'T1', channelId: 'C1', enabledAt: '2000-01-01T00:00:00.000Z' };
    slack.joinError = 'method_not_supported_for_channel_type';
    await push();
    await waitFor(() => h.cards().some((c) => c.title.includes('did not reach Slack')));
    expect(slack.uploads).toHaveLength(0);

    // The next push retries, joins, and posts one message with both pictures and the link.
    slack.joinError = null;
    signOff(people, 'src/people/page.tsx', 'people\n// signed\n');
    await push();
    await waitFor(() => slack.uploads.length > 0 || undefined);
    expect(slack.uploads).toHaveLength(1);
    expect(slack.joins).toEqual(['C1']);
    expect(slack.uploads[0]).toMatchObject({ channel_id: 'C1', files: 2 });
    expect(slack.uploads[0]?.comment).toContain(off?.url ?? 'missing');
    expect(slack.uploads[0]?.comment).toContain('Polish pages');
    expect(h.cards().filter((c) => c.title.includes('did not reach Slack'))).toHaveLength(0);

    // Marked posted for the pass (the post runs detached, so the mark is what keeps the next push from posting
    // again): another push to the same pull request posts nothing.
    await waitFor(
      () => getAppSetting(h.state.db, `slack-pictures-posted.${h.project.id}`) ?? undefined,
    );
    expect(getAppSetting(h.state.db, `slack-pictures-posted.${h.project.id}`)).toEqual({
      [passId]: off?.url,
    });
    await push();
    await h.jobs.idle();
    expect(slack.uploads).toHaveLength(1);
  });

  it('posts a finished task’s pictures to its Slack channel once, never a pass’s task, and tries a refused post again', async () => {
    const slack = fakeSlack();
    const client = createSlackClient({
      fetch: slack.fetch,
      token: () => Promise.resolve('xoxb-test'),
      clock: new ManualClock(),
      timeoutMs: 5_000,
    });
    let channel: { teamId: string; channelId: string; enabledAt: string | null } | null = null;
    setup({}, { slack: { channelOf: () => channel, clientFor: () => client } });
    const post = poster;
    if (post === null) throw new Error('no poster');
    const { people } = await openedPass();
    picture(people, 'after', '/people', 'people after');
    const task = h.addTask('Billing page', { areas: ['settings'] });
    picture(task, 'before', '/settings', 'billing before');
    picture(task, 'after', '/settings', 'billing after');
    h.state.write((w) => {
      setTaskStatus(w, task.id, 'done');
    });

    const other = h.addTask('Other page', { areas: ['settings'] });
    picture(other, 'after', '/settings', 'other after');

    // Sharing off, and a task that belongs to a pass: nothing goes out.
    post.announceTask(other.id);
    channel = { teamId: 'T1', channelId: 'C1', enabledAt: '2000-01-01T00:00:00.000Z' };
    post.announceTask(people.id);

    // Refused: one Inbox item says why, and nothing was uploaded.
    slack.joinError = 'method_not_supported_for_channel_type';
    post.announceTask(task.id);
    await waitFor(() => h.cards().some((c) => c.title.includes('did not reach Slack')));
    expect(slack.uploads).toHaveLength(0);

    // The retry posts one message with both pictures, the project and the task, and withdraws the item.
    slack.joinError = null;
    await post.retryTasks();
    expect(slack.uploads).toHaveLength(1);
    expect(slack.uploads[0]).toMatchObject({ channel_id: 'C1', files: 2 });
    expect(slack.uploads[0]?.comment).toContain(h.project.name);
    expect(slack.uploads[0]?.comment).toContain('Billing page');
    expect(h.cards().filter((c) => c.title.includes('did not reach Slack'))).toHaveLength(0);
    expect(getAppSetting(h.state.db, `slack-pictures-posted.${h.project.id}`)).toHaveProperty(
      task.id,
    );
  });
});

/** A daemon killed mid-gate on the pass's batch, `abandoned` or not, and start-up's recovery after it. */
async function reapsTheGate(name: string, abandoned: boolean): Promise<void> {
  setup();
  const { passId, settings } = await openedPass();
  const tip = signOff(settings, 'src/settings/page.tsx', 'signed off\n');
  const batchId = batchOf(passId);
  // What a daemon killed mid-gate leaves: the worktree on its branch, and the gate's group.
  const branch = scratchBranchName(passId);
  await h.git.addWorktree({
    repo: h.repo,
    path: worktreePathFor(madeWorktreeRoot(h.worktreeRoot), h.project, branch),
    branch,
    startPoint: tip,
    lockReason: worktreeLockReason(batchId),
  });
  const gate = await orphanGateGroup();
  try {
    h.state.write((w) =>
      patchBatch(w, batchId, { gatePid: gate.pid, gatePidStart: gate.startedAt }),
    );
    if (abandoned)
      h.state.write((w) => {
        setAbandonStep(w, passId, AbandonStep.Abandoning);
        abandonPassAndBatch(w, passId);
      });

    await recoverBatches({
      folderHold: h.ctx.folderHold,
      jobs: h.jobs,
      state: h.state,
      git: h.git,
      inbox: h.inbox,
      processes: systemProcesses,
      shipper: h.shipper,
      starter: h.starter,
      logger: silentLogger,
      worktrees: { ctx: h.ctx, root: h.worktreeRoot },
    });

    await gate.exited;
    await waitFor(() => !alive(gate.grandchildPid));
    expect.soft(getBatchRow(h.store.db, batchId), name).toMatchObject({
      state: abandoned ? 'ABANDONED' : 'OPEN',
      gatePid: null,
      gatePidStart: null,
    });
    expect.soft(h.git$('worktree', 'list'), name).not.toContain('gate-');
    expect.soft(h.git$('branch', '--list', branch), name).toBe('');
    expect
      .soft(
        h.cards().filter((c) => c.title.includes('branch')),
        name,
      )
      .toEqual([]);
  } finally {
    if (alive(gate.grandchildPid)) process.kill(gate.grandchildPid, 'SIGKILL');
    gate.cleanup();
  }
}

/** A fake Slack over `fetch`: one public channel the bot is not in, and every upload recorded. */
function fakeSlack() {
  const state = {
    uploads: [] as { channel_id: string; comment: string; files: number }[],
    joins: [] as string[],
    joinError: null as string | null,
    fetch: ((input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      const json = (body: unknown) => Promise.resolve(Response.json(body));
      if (url.hostname === 'files.example') return Promise.resolve(new Response('OK'));
      switch (url.pathname.split('/').pop() ?? '') {
        case 'conversations.list':
          return json({
            ok: true,
            channels: [
              { id: 'C1', name: 'ui', is_private: false, is_member: state.joins.length > 0 },
            ],
          });
        case 'conversations.join': {
          if (state.joinError !== null) return json({ ok: false, error: state.joinError });
          state.joins.push('C1');
          return json({ ok: true });
        }
        case 'files.getUploadURLExternal':
          return json({
            ok: true,
            upload_url: `https://files.example/${url.searchParams.get('filename') ?? ''}`,
            file_id: `F-${url.searchParams.get('filename') ?? ''}`,
          });
        case 'files.completeUploadExternal': {
          const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
            channel_id: string;
            initial_comment: string;
            files: unknown[];
          };
          state.uploads.push({
            channel_id: body.channel_id,
            comment: body.initial_comment,
            files: body.files.length,
          });
          return json({ ok: true });
        }
        default:
          return json({ ok: false, error: 'unknown_method' });
      }
    }) as typeof fetch,
  };
  return state;
}
