import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ConflictError,
  Delivery,
  PassNoticeKind,
  PassPullRequestGate,
  PassState,
  PullRequestState,
  WorkstreamState,
  type PassDto,
  type PassId,
  type PassPullRequestDto,
  type PassPullRequestPreviewDto,
  type ProjectDto,
} from '@10db/contracts';
import {
  clearPassNotice,
  getBatch,
  getPass,
  getPassProgress,
  getPassPullRequest,
  getProject,
  getWorkstream,
  listPassTasks,
  setPassNotice,
  setPassPullRequest,
  type DbReader,
} from '@10db/db';
import { GhError, PrState } from '../github';
import { ghCall, type DeliveryContext } from './context';
import { jobKey, JobQueue } from './jobs';
import { shipCheck } from './local-check';
import { createPassChecks } from './pass-checks';
import { passHasReview, REVIEW_CUT_NOTICE, type PassReviewDeps } from './pass-review';
import { PASS_PR_CLOSED_NOTICE } from './pass-watch';
import { readPrTemplate } from './pr-template';
import { passPrBody, prTitle, titlePrefix, type PassPrCheck } from './pr-text';
import { gateInScratch, type ScratchGateDeps } from './scratch-gate';
import { pushBranch, runGate } from './ship';

// Workbench spec §5.5, §8.3, W6, W8: a pass's pull request, on any delivery. Open Pull Request pushes
// the pass's branch, which holds signed-off pages only, and opens a draft; its gate and its one review
// then read the pushed commit outside the delivery key. The close (slice 7a) is handed the same steps
// as `PassShipDeps`, injected by the composition root, since `pass/` never imports this module.

/** What a pass's close needs of its pull request and its gate (slice 7a's seam). */
export interface PassShipDeps {
  /** Scratch worktree where copies are allowed, else the folder. Through `shipGate`; pid on the batch row. */
  gatePassTip(i: {
    passId: PassId;
    sha: string;
    where: 'scratch' | 'folder';
    signal: AbortSignal;
  }): Promise<{
    passed: boolean;
    aborted: boolean;
    logPath: string;
    dirtyNamed: readonly string[];
  }>;
  pushPassBranch(passId: PassId, signal: AbortSignal): Promise<'pushed' | 'no_origin'>;
  /** Draft at Open Pull Request, ready at close; base = the stacked-on pass's branch while its PR is open. */
  ensurePassPr(
    i: { passId: PassId; ready: boolean },
    signal: AbortSignal,
  ): Promise<{ url: string } | null>;
  /** Raises the abort of an Open-PR gate or review still running for the pass, and waits for it to end. */
  stopPassChecks(passId: PassId): Promise<void>;
}

export interface PassPullRequestDeps extends ScratchGateDeps, DeliveryContext {
  /** True while a waiting update drains the factory: no gate starts. */
  readonly holdShips?: () => boolean;
  /** The one review's model; null runs no review. */
  readonly review: PassReviewDeps | null;
}

/** A pass's pull request: what the routes ask, and the close's steps. */
export interface PassPullRequests extends PassShipDeps {
  /** `GET /passes/:passId/pull-request`. */
  preview(passId: PassId): Promise<PassPullRequestPreviewDto>;
  /**
   * `POST /passes/:passId/pull-request`: queues the push and the draft in the delivery key, then the
   * gate and the review outside it, and answers at once. Refused (409) when the preview offers none.
   */
  open(passId: PassId): Promise<PassPullRequestDto>;
  /** Stops every pass's running checks, as the daemon shuts down. */
  stop(): Promise<void>;
}

/** Where the pass's pull request is gated: a scratch worktree where copies are allowed, else the folder at close. */
export function passGateKind(project: ProjectDto): PassPullRequestGate {
  if (shipCheck(project) === null) return PassPullRequestGate.None;
  return project.delivery === Delivery.PullRequest
    ? PassPullRequestGate.Scratch
    : PassPullRequestGate.FolderAtClose;
}

/**
 * The branch the pass's pull request targets (D24): the branch of the closed pass it is stacked on,
 * while that pass's own pull request is still open, else the project's base.
 */
export function passPrBase(db: DbReader, pass: PassDto): string {
  const batch = getBatch(db, pass.batchId);
  const on = getPassProgress(db, pass.id).stackedOn;
  if (on === null) return batch.baseBranch;
  const below = getPass(db, on);
  const pr = getPassPullRequest(db, on);
  const merged = pr?.state === PullRequestState.Merged || pr?.state === PullRequestState.Closed;
  const branch = getBatch(db, below.batchId).branch;
  return below.state === PassState.Closed && !merged && branch !== null ? branch : batch.baseBranch;
}

/** The titles of the pass's signed-off pages, in the order they joined it. */
function signedOff(db: DbReader, passId: PassId): string[] {
  return listPassTasks(db, passId).flatMap((task) =>
    task.workstreamId !== null &&
    getWorkstream(db, task.workstreamId).state === WorkstreamState.Done
      ? [task.title]
      : [],
  );
}

const GATE_NOTICE = 'gate';
/** The header notice that says Open Pull Request did not finish. */
const PR_OPEN_NOTICE = 'pr-open';

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function createPassPullRequests(deps: PassPullRequestDeps): PassPullRequests {
  const db = deps.state.db;
  /** How each pass's body says it was checked, as its last gate left it. */
  const checked = new Map<PassId, PassPrCheck>();

  function checkOf(pass: PassDto, project: ProjectDto, sha: string): PassPrCheck {
    const known = checked.get(pass.id);
    if (known) return known;
    const command = shipCheck(project)?.command;
    switch (passGateKind(project)) {
      case PassPullRequestGate.None:
        return { kind: 'none' };
      case PassPullRequestGate.FolderAtClose:
        return { kind: 'folder_at_close', command: command ?? '' };
      case PassPullRequestGate.Scratch:
        return { kind: 'scratch', command: command ?? '', sha, state: 'running' };
    }
  }

  /** Where the pass is: its batch, its project and its branch's repository on GitHub. */
  function placeOf(passId: PassId) {
    const pass = getPass(db, passId);
    const batch = getBatch(db, pass.batchId);
    const project = getProject(db, pass.projectId);
    return { pass, batch, project };
  }

  async function gatePassTip(i: {
    passId: PassId;
    sha: string;
    where: 'scratch' | 'folder';
    signal: AbortSignal;
  }): Promise<{
    passed: boolean;
    aborted: boolean;
    logPath: string;
    dirtyNamed: readonly string[];
  }> {
    const { pass, batch, project } = placeOf(i.passId);
    const command = shipCheck(project)?.command ?? '';
    const beforeStart = () => Promise.resolve(deps.holdShips?.() !== true);
    if (i.where === 'folder') {
      const result = await runGate(deps, batch, project, i.signal, beforeStart);
      if (result === null) return { passed: false, aborted: true, logPath: '', dirtyNamed: [] };
      const dirty = await deps.git.changedPaths(project.repoPath);
      const passed = result.exitCode === 0;
      checked.set(pass.id, { kind: 'folder', command, passed, dirty });
      return { passed, aborted: false, logPath: result.logPath, dirtyNamed: dirty };
    }
    const ran = await gateInScratch(deps, {
      batch,
      project,
      passId: pass.id,
      sha: i.sha,
      signal: i.signal,
      beforeStart,
    });
    if (ran.kind === 'aborted') {
      // Held back or stopped: the body says it did not run, not that it is running.
      checked.set(pass.id, { kind: 'scratch', command, sha: i.sha, state: 'not_run' });
      return { passed: false, aborted: true, logPath: '', dirtyNamed: [] };
    }
    const passed = ran.kind === 'ran' && ran.result.exitCode === 0;
    const logPath = ran.kind === 'ran' ? ran.result.logPath : (ran.logPath ?? '');
    checked.set(pass.id, {
      kind: 'scratch',
      command,
      sha: i.sha,
      state: passed ? 'passed' : 'failed',
    });
    deps.state.write((w) => {
      if (passed) {
        clearPassNotice(w, pass.id, GATE_NOTICE);
        return;
      }
      setPassNotice(w, pass.id, {
        id: GATE_NOTICE,
        kind: PassNoticeKind.GateFailed,
        text:
          ran.kind === 'ran'
            ? `The gate failed on ${i.sha.slice(0, 7)}, run in a scratch worktree of the pushed commit:\n${ran.result.tail}`
            : `The gate's install failed in a scratch worktree of ${i.sha.slice(0, 7)}, so the gate did not run.`,
        sendable: true,
        cardId: null,
        at: w.now,
      });
    });
    return { passed, aborted: false, logPath, dirtyNamed: [] };
  }

  async function pushPassBranch(
    passId: PassId,
    signal: AbortSignal,
  ): Promise<'pushed' | 'no_origin'> {
    const { batch, project } = placeOf(passId);
    if ((await deps.git.remoteUrl(project.repoPath, 'origin')) === null) return 'no_origin';
    const branch = batch.branch;
    if (branch === null) throw new ConflictError(`Pass batch "${batch.title}" has no branch`);
    await pushBranch(deps, batch, project, branch, signal);
    return 'pushed';
  }

  async function writeBody(passId: PassId, sha: string, repo: string): Promise<string> {
    const { pass, batch, project } = placeOf(passId);
    const file = join(deps.dataDir, 'delivery', `${batch.id}-pr-body.md`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      passPrBody({
        pass,
        pages: signedOff(db, passId),
        check: checkOf(pass, project, sha),
        ci: { repo, sha },
        template: await readPrTemplate(deps.git, project.repoPath, sha, deps.logger),
        reviewCut: getPassProgress(db, passId).notices.some((n) => n.id === REVIEW_CUT_NOTICE),
      }),
    );
    return file;
  }

  async function ensurePassPr(
    i: { passId: PassId; ready: boolean },
    signal: AbortSignal,
  ): Promise<{ url: string } | null> {
    const { pass, batch, project } = placeOf(i.passId);
    const repo = batch.repo;
    const branch = batch.branch;
    if (repo === null || branch === null) return null;
    const call = ghCall(deps, signal);
    const sha = await deps.git.branchTip(project.repoPath, branch);
    if (sha === null) throw new ConflictError(`The branch of pass "${pass.name}" is gone`);
    const bodyFile = await writeBody(pass.id, sha, repo);
    let found = getPassPullRequest(db, pass.id);
    if (found === null) {
      // A pull request an earlier run opened before it could record it.
      const seen = await deps.gh.prView({ repo, ref: branch }, call);
      if (seen !== null && seen.state === PrState.Open) {
        found = { url: seen.url, draft: seen.isDraft, state: null, failingChecks: [] };
        const draft = seen.isDraft ?? true;
        deps.state.write((w) => {
          setPassPullRequest(w, pass.id, { url: seen.url, draft });
        });
      }
    }
    if (found === null) {
      const pages = signedOff(db, pass.id).map((title) => ({ title }));
      const url = await deps.gh.prCreate(
        {
          repo,
          base: passPrBase(db, pass),
          head: branch,
          title: prTitle(project.prTitlePrefix ?? titlePrefix(pages, null), pass.name),
          bodyFile,
          draft: !i.ready,
        },
        call,
      );
      deps.state.write((w) => {
        setPassPullRequest(w, pass.id, { url, draft: !i.ready });
        // A pull request that closed unmerged before this one is history now.
        clearPassNotice(w, pass.id, PASS_PR_CLOSED_NOTICE);
      });
      deps.logger.info({ passId: pass.id, url, draft: !i.ready }, 'pass pull request opened');
      return { url };
    }
    const url = found.url;
    await deps.gh.prEditBody({ repo, url, bodyFile }, call);
    if (i.ready && found.draft !== false) {
      await deps.gh.prReady({ repo, url }, call);
      deps.state.write((w) => {
        setPassPullRequest(w, pass.id, { url, draft: false });
      });
    }
    return { url };
  }

  /** Rewrites the pull request's body from the rows; one gh can't edit keeps the lines it had. */
  async function rewriteBody(passId: PassId, sha: string, signal: AbortSignal): Promise<void> {
    const { batch } = placeOf(passId);
    const pr = getPassPullRequest(db, passId);
    if (pr === null || batch.repo === null) return;
    const bodyFile = await writeBody(passId, sha, batch.repo);
    await deps.gh
      .prEditBody({ repo: batch.repo, url: pr.url, bodyFile }, ghCall(deps, signal))
      .catch((error: unknown) => {
        deps.logger.warn({ passId, err: message(error) }, 'pass pull request body not updated');
      });
  }

  const checks = createPassChecks({
    ...deps,
    gate: async ({ passId, sha, signal }) => {
      await gatePassTip({ passId, sha, where: 'scratch', signal });
      // The body says how the gate went; a shutdown or a close that stopped it writes nothing.
      if (!signal.aborted) await rewriteBody(passId, sha, signal);
    },
    review: deps.review,
    // The body says when the review read only part of the diff.
    reviewed: rewriteBody,
  });

  async function preview(passId: PassId): Promise<PassPullRequestPreviewDto> {
    const { pass, batch, project } = placeOf(passId);
    const base = passPrBase(db, pass);
    const pr = getPassPullRequest(db, passId);
    const existing = pr === null ? null : { url: pr.url, draft: pr.draft ?? true };
    const gate = passGateKind(project);
    const refuse = (reason: string, aheadOfBase: number | null = null) => ({
      offered: false,
      reason,
      aheadOfBase,
      base,
      existing,
      gate,
    });
    const repo = project.repoPath;
    const tip = batch.branch === null ? null : await deps.git.branchTip(repo, batch.branch);
    const tracked = await deps.git.trackingTip(repo, base).catch(() => null);
    const ahead =
      tracked === null
        ? null
        : await deps.git
            .commitsSince(repo, tracked, pass.startSha)
            .then((shas) => shas.length)
            .catch(() => null);
    if (pass.state !== PassState.Open)
      return refuse(`The pass is ${pass.state.toLowerCase()}`, ahead);
    // Its work is in the base: the close that follows a merge (slice 7a) is what is left to do.
    if (pr?.state === PullRequestState.Merged)
      return refuse("The pass's pull request has merged; close the pass", ahead);
    if (tip === null || tip === pass.startSha)
      return refuse(
        'Nothing is signed off yet: the pull request holds signed-off pages only',
        ahead,
      );
    if ((await deps.git.remoteUrl(repo, 'origin')) === null)
      return refuse(`${project.name} has no origin, so the pass lands by its close alone`, ahead);
    if (batch.repo === null)
      return refuse(`origin of ${project.name} is not a GitHub repository`, ahead);
    try {
      await deps.gh.authStatus(ghCall(deps, AbortSignal.timeout(deps.limits.networkTimeoutMs)));
    } catch (error) {
      return refuse(
        error instanceof GhError ? `gh can't open it: ${error.message}` : message(error),
        ahead,
      );
    }
    return { offered: true, reason: null, aheadOfBase: ahead, base, existing, gate };
  }

  return {
    gatePassTip,
    pushPassBranch,
    ensurePassPr,
    stopPassChecks: (passId) => checks.stop(passId),
    preview,
    async open(passId) {
      const shown = await preview(passId);
      if (!shown.offered)
        throw new ConflictError(shown.reason ?? 'Open Pull Request is not offered');
      const { pass, batch, project } = placeOf(passId);
      const branch = batch.branch;
      const tip = branch === null ? null : await deps.git.branchTip(project.repoPath, branch);
      const reviewed = getPassProgress(db, passId).reviewedSha;
      const review =
        deps.review === null || !passHasReview(db, passId)
          ? 'none'
          : reviewed !== null && reviewed === tip
            ? 'unchanged'
            : 'started';
      const stillOpen = (): boolean => getPass(db, passId).state === PassState.Open;
      const reviews = review !== 'none';
      deps.jobs.run(jobKey(batch, JobQueue.Ship), async (signal) => {
        if (signal.aborted || getPass(db, passId).state !== PassState.Open || branch === null)
          return;
        try {
          if ((await pushPassBranch(passId, signal)) === 'no_origin') return;
          const sha = await deps.git.branchTip(project.repoPath, branch);
          // An Abandon or a close that took the pass while the branch was pushed: no pull request,
          // and no gate or review, is started for it.
          if (sha === null || !stillOpen()) return;
          await ensurePassPr({ passId, ready: false }, signal);
          deps.state.write((w) => clearPassNotice(w, passId, PR_OPEN_NOTICE));
          if (!stillOpen()) return;
          checks.start({
            passId,
            sha,
            gate: shown.gate === PassPullRequestGate.Scratch,
            // Decided on the tip pushed: a page that landed since the request makes it new.
            review: reviews && getPassProgress(db, passId).reviewedSha !== sha,
            baseRef: `refs/remotes/origin/${shown.base}`,
          });
        } catch (error) {
          deps.logger.warn(
            { passId: pass.id, err: message(error) },
            'pass pull request not opened',
          );
          // A function, so the check after the awaits is not narrowed away by the one before them.
          const stopped = (): boolean => signal.aborted;
          if (stopped()) return;
          deps.state.write((w) => {
            setPassNotice(w, passId, {
              id: PR_OPEN_NOTICE,
              kind: PassNoticeKind.PrNotOpened,
              text: `Open Pull Request did not finish: ${message(error)}`,
              sendable: false,
              cardId: null,
              at: w.now,
            });
          });
        }
      });
      return { url: shown.existing?.url ?? null, base: shown.base, gate: shown.gate, review };
    },
    stop: () => checks.stopAll(),
  };
}
