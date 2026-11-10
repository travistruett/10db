import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  PassGateState,
  PassNoticeKind,
  type PassId,
  type ProjectInput,
  type TaskDto,
} from '@10db/contracts';
import { AbandonStep } from '@10db/contracts';
import {
  findFlowByName,
  setAbandonStep,
  setPassNotice,
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
} from '@10db/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { silentLogger } from '../log';
import { systemProcesses } from '../recovery';
import type { Git } from '../git';
import { GhError } from '../github';
import { CompletionError } from '../sessions';
import { createGateRunner } from '../verify';
import { SANDBOXED, waitFor } from '../../test/fixtures';
import { alive, orphanGateGroup } from '../../test/orphan-gate';
import { openPass, recoverBatches, type PutBackKeptWork } from './index';
import { createPassChecks } from './pass-checks';
import { createPassPullRequests, type PassPullRequests } from './pass-pr';
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
  } = {},
) {
  h = createDeliveryHarness(
    { ...PAGES, gateCommand: GATE, ...project },
    opts.wrapGit ? { wrapGit: opts.wrapGit } : {},
  );
  const deps = {
    ...h.ctx,
    gate: createGateRunner({ sandbox: null, logger: silentLogger }),
    dataDir: h.dataDir,
    sessionEnv: () => ({ PATH: '/usr/bin:/bin' }),
    identifyProcess: (pid: number) => systemProcesses.identify(pid),
    review: opts.review ?? null,
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

const gateState = (passId: PassId) => getPassChecks(h.store.db, passId).gate.state;
const notices = (passId: PassId) => getPassProgress(h.store.db, passId).notices;
const batchOf = (passId: PassId) => getPass(h.store.db, passId).batchId;

describe('Open Pull Request', () => {
  it('is not offered before a page is signed off, nor with no origin', async () => {
    setup();
    const { passId, settings } = await openedPass();

    expect(await prs.preview(passId)).toMatchObject({
      offered: false,
      reason: expect.stringContaining('Nothing is signed off') as unknown,
      base: 'main',
      existing: null,
      gate: 'scratch',
    });
    await expect(prs.open(passId)).rejects.toMatchObject({ name: 'ConflictError' });

    signOff(settings, 'src/settings/page.tsx', 'signed off\n');
    h.git$('remote', 'remove', 'origin');
    expect(await prs.preview(passId)).toMatchObject({
      offered: false,
      reason: expect.stringContaining('no origin') as unknown,
    });
    expect(h.gh.calls.filter((c) => c.method === 'prCreate')).toEqual([]);
  });

  it("is not offered once the pass's pull request has merged", async () => {
    setup({ gateCommand: null });
    const { passId, settings } = await openedPass();
    signOff(settings, 'src/settings/page.tsx', 'signed off\n');
    await prs.open(passId);
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

  it('pushes the branch and opens a draft, then gates the pushed commit in a scratch worktree, never the open page on disk', async () => {
    setup();
    const { passId, settings } = await openedPass();
    const tip = signOff(settings, 'src/settings/page.tsx', 'signed off\n');
    // The people page is still open: its file on disk is not what the branch holds.
    write('src/people/page.tsx', 'half done\n');

    const preview = await prs.preview(passId);
    expect(preview).toMatchObject({ offered: true, reason: null, base: 'main', aheadOfBase: 0 });
    const answer = await prs.open(passId);
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
    await vi.waitFor(() => {
      expect(h.gh.body(pr?.url ?? '')).toContain('Gate passed in a scratch worktree');
    });
    expect(h.gh.body(pr?.url ?? '')).toContain('- Settings page');
    expect(h.gh.body(pr?.url ?? '')).not.toContain('People page');
    // The scratch worktree and its branch are gone; the folder is as the builder left it.
    expect(h.git$('worktree', 'list')).not.toContain('gate-');
    expect(h.git$('branch', '--list', scratchBranchName(passId))).toBe('');
    expect(h.git$('rev-parse', '--abbrev-ref', 'HEAD')).toBe(branch);
    expect(h.git$('status', '--porcelain')).toBe('M src/people/page.tsx');
  });

  it('pushes to the pull request it already has, rewriting its body rather than opening another', async () => {
    setup();
    const { passId, settings, people } = await openedPass();
    signOff(settings, 'src/settings/page.tsx', 'signed off\n');
    await prs.open(passId);
    await h.jobs.idle();
    await vi.waitFor(
      () => {
        expect(gateState(passId)).toBe(PassGateState.Passed);
      },
      { timeout: 20_000 },
    );
    const url = getPassPullRequest(h.store.db, passId)?.url ?? '';

    const tip = signOff(people, 'src/people/page.tsx', 'people\n// signed\n');
    expect(await prs.open(passId)).toMatchObject({ url });
    await h.jobs.idle();

    const branch = getBatch(h.store.db, batchOf(passId)).branch ?? '';
    expect(h.origin$('rev-parse', `refs/heads/${branch}`)).toBe(tip);
    expect(h.gh.prCreates()).toHaveLength(1);
    expect(h.gh.body(url)).toContain('- People page');
  });

  it('marks a failed gate in the header and the body, and the batch stays open', async () => {
    setup({ gateCommand: 'echo broken; exit 3' });
    const { passId, settings } = await openedPass();
    signOff(settings, 'src/settings/page.tsx', 'signed off\n');

    await prs.open(passId);
    await h.jobs.idle();

    await vi.waitFor(
      () => {
        expect(gateState(passId)).toBe(PassGateState.Failed);
      },
      { timeout: 20_000 },
    );
    const url = getPassPullRequest(h.store.db, passId)?.url ?? '';
    await vi.waitFor(() => {
      expect(h.gh.body(url)).toContain('Gate failed in a scratch worktree');
    });
    expect(getPassProgress(h.store.db, passId).notices).toEqual([
      expect.objectContaining({ id: 'gate', kind: PassNoticeKind.GateFailed, sendable: true }),
    ]);
    expect(getBatch(h.store.db, batchOf(passId)).state).toBe('OPEN');
  });

  it('says in the header when the push or the pull request did not go through, until one does', async () => {
    setup();
    const { passId, settings } = await openedPass();
    signOff(settings, 'src/settings/page.tsx', 'signed off\n');
    h.gh.failNext.set(
      'prCreate',
      new GhError('failed', 'HTTP 422: No commits between main and it'),
    );

    await prs.open(passId);
    await h.jobs.idle();

    expect(notices(passId)).toEqual([
      expect.objectContaining({
        id: 'pr-open',
        kind: PassNoticeKind.PrNotOpened,
        text: expect.stringContaining('No commits between') as unknown,
      }),
    ]);
    await prs.open(passId);
    await h.jobs.idle();
    expect(h.gh.prCreates()).toHaveLength(1);
    expect(notices(passId).filter((n) => n.id === 'pr-open')).toEqual([]);
  });

  it('says in the header when the review could not ask its model', async () => {
    setup(
      { gateCommand: null },
      {
        review: {
          adapter: { complete: () => Promise.reject(new CompletionError('The model failed.')) },
          launch: (_account, model) => ({ model, env: {}, expect: { kind: 'any' } as never }),
          scratchRoot: tmpdir(),
        },
      },
    );
    const standard = findFlowByName(h.store.db, 'standard');
    if (standard) h.state.write((w) => patchProject(w, h.project.id, { flowId: standard.id }));
    const { passId, settings } = await openedPass();
    signOff(settings, 'src/settings/page.tsx', 'signed off\n');

    expect(await prs.open(passId)).toMatchObject({ review: 'started' });
    await h.jobs.idle();

    await vi.waitFor(() => {
      expect(notices(passId)).toEqual([
        expect.objectContaining({ id: 'review', kind: PassNoticeKind.ReviewFailed }),
      ]);
    });
  });

  it('opens no pull request and starts no gate for a pass abandoned while its branch was pushed', async () => {
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

    await prs.open(passId);
    await h.jobs.idle();
    await prs.stopPassChecks(passId);

    expect(h.gh.prCreates()).toEqual([]);
    expect(h.logs.lines().filter((l) => l['msg'] === 'gate started')).toEqual([]);
  });

  it('starts no checks for a pass that is no longer open', async () => {
    setup();
    const { passId, settings } = await openedPass();
    signOff(settings, 'src/settings/page.tsx', 'signed off\n');
    h.state.write((w) => {
      setAbandonStep(w, passId, AbandonStep.Abandoning);
    });
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

  it('says in the header when the gate could not run at all', async () => {
    setup();
    const { passId, settings } = await openedPass();
    const tip = signOff(settings, 'src/settings/page.tsx', 'signed off\n');
    const checks = createPassChecks({
      ...h.ctx,
      gate: () => Promise.reject(new Error('no room for a scratch worktree')),
      review: null,
      reviewed: () => Promise.resolve(),
    });

    checks.start({ passId, sha: tip, gate: true, review: false, baseRef: null });

    await vi.waitFor(() => {
      expect(notices(passId)).toEqual([
        expect.objectContaining({
          id: 'gate',
          kind: PassNoticeKind.GateFailed,
          sendable: false,
          text: `The gate on ${tip.slice(0, 7)} could not run: no room for a scratch worktree`,
        }),
      ]);
    });
    await checks.stop(passId);
  });

  it('logs, and leaves nothing unhandled, when what follows a review fails', async () => {
    setup({ gateCommand: null });
    const standard = findFlowByName(h.store.db, 'standard');
    if (standard) h.state.write((w) => patchProject(w, h.project.id, { flowId: standard.id }));
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
      await vi.waitFor(() => {
        expect(h.logs.lines()).toContainEqual(
          expect.objectContaining({
            msg: 'pass pull request body not updated',
            err: 'the body file could not be written',
          }),
        );
      });
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

    expect(await prs.open(passId)).toMatchObject({ gate: 'folder_at_close' });
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

    await prs.open(passId);
    await h.jobs.idle();

    await vi.waitFor(() => {
      expect(h.logs.lines()).toContainEqual(
        expect.objectContaining({ msg: 'gate finished', aborted: true }),
      );
    });
    expect(h.gh.prCreates()).toHaveLength(1);
    expect(gateState(passId)).toBe(PassGateState.NotRun);
    await vi.waitFor(() => {
      expect(h.git$('worktree', 'list')).not.toContain('gate-');
    });
    // The body says the gate did not run, not that it is running.
    const url = getPassPullRequest(h.store.db, passId)?.url ?? '';
    await vi.waitFor(() => {
      expect(h.gh.body(url)).toContain('Gate not run');
    });
    expect(h.gh.body(url)).not.toContain('Gate running');
  });

  it.each([
    {
      name: 'the pull request could not be opened',
      arrange: () => {
        h.gh.failNext.set('prCreate', new GhError('failed', 'HTTP 502: Bad Gateway'));
      },
    },
    {
      name: 'the pass was abandoned while its pull request opened',
      arrange: (passId: PassId) => {
        const create = h.gh.prCreate.bind(h.gh);
        h.gh.prCreate = async (input) => {
          const url = await create(input);
          h.state.write((w) => {
            setAbandonStep(w, passId, AbandonStep.Abandoning);
          });
          return url;
        };
      },
    },
    {
      name: 'the gate could not run',
      wrapGit: (git: Git): Git => ({
        ...git,
        addWorktree: () => Promise.reject(new Error('no room for a scratch worktree')),
      }),
      arrange: () => undefined,
      // The gate is left to fail on its own, not stopped first.
      until: (passId: PassId) => notices(passId).some((n) => n.id === 'gate'),
    },
  ])(
    'writes no running gate into the body once Open Pull Request stops because $name',
    async ({ arrange, wrapGit, until }) => {
      setup({}, wrapGit ? { wrapGit } : {});
      const { passId, settings } = await openedPass();
      signOff(settings, 'src/settings/page.tsx', 'signed off\n');
      arrange(passId);

      await prs.open(passId);
      await h.jobs.idle();
      if (until)
        await vi.waitFor(() => {
          expect(until(passId)).toBe(true);
        });
      await prs.stopPassChecks(passId);
      // The close writes the body again, marking the pull request ready.
      await prs.ensurePassPr({ passId, ready: true }, new AbortController().signal);

      const url = getPassPullRequest(h.store.db, passId)?.url ?? '';
      expect(h.gh.body(url)).not.toContain('Gate running');
      expect(h.gh.body(url)).toContain('Gate result unknown');
    },
  );

  /** Scratch worktrees that wait, one at a time, until the test lets each go on or fail. */
  function heldWorktrees() {
    const waiting: ((error: Error | null) => void)[] = [];
    let calls = 0;
    return {
      wrap: (git: Git): Git => ({
        ...git,
        addWorktree: async (input) => {
          calls += 1;
          const error = await new Promise<Error | null>((resolve) => waiting.push(resolve));
          if (error) throw error;
          return git.addWorktree(input);
        },
      }),
      calls: () => calls,
      release: (error: Error | null = null) => {
        waiting.shift()?.(error);
      },
    };
  }

  const bodyOf = (passId: PassId) => h.gh.body(getPassPullRequest(h.store.db, passId)?.url ?? '');
  const gateStarted = (held: ReturnType<typeof heldWorktrees>, n: number) =>
    vi.waitFor(() => {
      expect(held.calls()).toBe(n);
    });

  it('writes no running gate once a second Open Pull Request finds the pass gone before its gate starts', async () => {
    const held = heldWorktrees();
    setup({}, { wrapGit: held.wrap });
    const { passId, settings } = await openedPass();
    signOff(settings, 'src/settings/page.tsx', 'signed off\n');
    await prs.open(passId);
    await h.jobs.idle();
    await gateStarted(held, 1);
    // The second waits for the first gate to stop, and the pass is abandoned meanwhile.
    await prs.open(passId);
    await h.jobs.idle();
    h.state.write((w) => {
      setAbandonStep(w, passId, AbandonStep.Abandoning);
    });
    held.release();

    await vi.waitFor(async () => {
      await prs.ensurePassPr({ passId, ready: true }, new AbortController().signal);
      expect(bodyOf(passId)).not.toContain('Gate running');
    });
  });

  it("says the gate is running while a second Open Pull Request's gate runs, though the first one's stopped", async () => {
    const held = heldWorktrees();
    setup({}, { wrapGit: held.wrap });
    const { passId, settings } = await openedPass();
    signOff(settings, 'src/settings/page.tsx', 'signed off\n');
    await prs.open(passId);
    await h.jobs.idle();
    await gateStarted(held, 1);
    await prs.open(passId);
    await h.jobs.idle();
    // The first gate goes on to find itself stopped; the second, of the same commit, starts.
    held.release();
    await gateStarted(held, 2);

    await prs.ensurePassPr({ passId, ready: false }, new AbortController().signal);

    expect(bodyOf(passId)).toContain('Gate running');
    held.release();
  });

  it("keeps the gate's own error when the body cannot be written after it", async () => {
    const held = heldWorktrees();
    setup({}, { wrapGit: held.wrap });
    const { passId, settings } = await openedPass();
    signOff(settings, 'src/settings/page.tsx', 'signed off\n');
    await prs.open(passId);
    await h.jobs.idle();
    await gateStarted(held, 1);
    // The body's file can no longer be written: a folder stands where it was.
    const file = join(h.dataDir, 'delivery', `${batchOf(passId)}-pr-body.md`);
    rmSync(file);
    mkdirSync(file);

    held.release(new Error('no room for a scratch worktree'));

    await vi.waitFor(() => {
      expect(notices(passId)).toEqual([
        expect.objectContaining({
          id: 'gate',
          text: expect.stringContaining('no room for a scratch worktree') as unknown,
        }),
      ]);
    });
  });

  it('after a restart, writes no running gate into the body when none runs', async () => {
    setup();
    const { passId, settings } = await openedPass();
    signOff(settings, 'src/settings/page.tsx', 'signed off\n');
    await prs.open(passId);
    await h.jobs.idle();
    await vi.waitFor(
      () => {
        expect(gateState(passId)).toBe(PassGateState.Passed);
      },
      { timeout: 20_000 },
    );
    const url = getPassPullRequest(h.store.db, passId)?.url ?? '';

    // The restarted daemon knows nothing of the gate it ran, and starts none: the close marks it ready.
    await restarted().ensurePassPr({ passId, ready: true }, new AbortController().signal);

    expect(h.gh.body(url)).not.toContain('Gate running');
    expect(h.gh.body(url)).toContain('Gate result unknown');
  });

  it("clears the header's closed pull request notice once a new one is opened", async () => {
    setup({ gateCommand: null });
    const { passId, settings } = await openedPass();
    signOff(settings, 'src/settings/page.tsx', 'signed off\n');
    h.state.write((w) => {
      setPassNotice(w, passId, {
        id: 'pr-closed',
        kind: PassNoticeKind.PrClosed,
        text: 'The pull request closed without merging.',
        sendable: false,
        cardId: null,
        at: w.now,
      });
    });

    await prs.open(passId);
    await h.jobs.idle();

    expect(h.gh.prCreates()).toHaveLength(1);
    expect(notices(passId)).toEqual([]);
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
    const standard = findFlowByName(h.store.db, 'standard');
    if (standard) h.state.write((w) => patchProject(w, h.project.id, { flowId: standard.id }));
    const { passId, settings, people } = await openedPass();
    signOff(settings, 'src/settings/page.tsx', 'signed off\n');
    await prs.open(passId);
    await h.jobs.idle();
    await vi.waitFor(() => {
      expect(asked).toHaveLength(1);
    });

    // Asked with the tip already reviewed, a page lands before the push: the push's tip is new.
    expect(await prs.open(passId)).toMatchObject({ review: 'unchanged' });
    const tip = signOff(people, 'src/people/page.tsx', 'people, signed\n');
    await h.jobs.idle();

    await vi.waitFor(() => {
      expect(getPassProgress(h.store.db, passId).reviewedSha).toBe(tip);
    });
    expect(asked).toHaveLength(2);
  });

  it('reviews the same tip again while a cut review left files unread', async () => {
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
    const standard = findFlowByName(h.store.db, 'standard');
    if (standard) h.state.write((w) => patchProject(w, h.project.id, { flowId: standard.id }));
    const { passId, settings } = await openedPass();
    // About 500 kB of diff over five files: more than one review reads.
    const long = (name: string) => `${`${name} ${'x'.repeat(100)}\n`.repeat(1_000)}${name}-end\n`;
    for (const name of ['a', 'b', 'c', 'd']) h.commit(`src/settings/${name}.tsx`, long(name));
    const tip = signOff(settings, 'src/settings/e.tsx', long('e'));
    await prs.open(passId);
    await h.jobs.idle();
    await vi.waitFor(() => {
      expect(getPassProgress(h.store.db, passId).reviewedSha).toBe(tip);
    });

    expect(await prs.open(passId)).toMatchObject({ review: 'started' });
    await h.jobs.idle();

    await vi.waitFor(() => {
      expect(asked).toHaveLength(2);
    });
    expect(asked[1]).toContain('+e-end');
    await vi.waitFor(() => {
      expect(notices(passId).filter((n) => n.id === 'review-cut')).toEqual([]);
    });
  });
});

describe('a restart during an Open Pull Request gate', () => {
  // Identifies the process with `ps`, which is setuid: no sandbox can run it.
  it.skipIf(SANDBOXED)(
    "reaps the gate the pass's open batch recorded and removes the scratch worktree and branch it left",
    async () => {
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

        await recoverBatches({
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
        expect(getBatchRow(h.store.db, batchId)).toMatchObject({
          state: 'OPEN',
          gatePid: null,
          gatePidStart: null,
        });
        expect(h.git$('worktree', 'list')).not.toContain('gate-');
        expect(h.git$('branch', '--list', branch)).toBe('');
        expect(h.cards().filter((c) => c.title.includes('branch'))).toEqual([]);
      } finally {
        if (alive(gate.grandchildPid)) process.kill(gate.grandchildPid, 'SIGKILL');
        gate.cleanup();
      }
    },
  );
});
