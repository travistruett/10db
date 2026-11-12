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
  forgetPassPullRequest,
  getBatch,
  getPass,
  getPassProgress,
  getPassPullRequest,
  getProject,
  getTaskScreenRow,
  getWorkstream,
  listPassTasks,
  listTaskScreens,
  setPassNotice,
  setPassPullRequest,
  type DbReader,
} from '@10db/db';
import { GhError, PrState } from '../github';
import { ghCall, networkCall, pushCall, type DeliveryContext } from './context';
import { jobKey, JobQueue } from './jobs';
import { shipCheck } from './local-check';
import { createPassChecks } from './pass-checks';
import { passHasReview, REVIEW_CUT_NOTICE, type PassReviewDeps } from './pass-review';
import { PASS_PR_CLOSED_NOTICE } from './pass-watch';
import { reviewHasUnread } from './review-left';
import { readPrTemplate } from './pr-template';
import { picturePlan, picturesSection } from './pr-pictures';
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
    /** The end of the gate's log; empty when it did not run. */
    tail: string;
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
  /**
   * Call 6: the pass's pull request merged while it was open, and pages were signed off after its
   * last push. Pushes the branch and opens a follow-on pull request against the base, ready for
   * review, in the merged one's place on the batch; null with no origin or GitHub repository.
   */
  openFollowOnPr(passId: PassId, signal: AbortSignal): Promise<{ url: string } | null>;
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
 * while that pass's own pull request is still open, else the project's base. A `local` project's
 * pass, settled at its close, counts the same while its record pull request is unmerged.
 */
export function passPrBase(db: DbReader, pass: PassDto): string {
  const batch = getBatch(db, pass.batchId);
  const on = getPassProgress(db, pass.id).stackedOn;
  if (on === null) return batch.baseBranch;
  const below = getPass(db, on);
  const pr = getPassPullRequest(db, on);
  const merged = pr?.state === PullRequestState.Merged || pr?.state === PullRequestState.Closed;
  const branch = getBatch(db, below.batchId).branch;
  // A local project's pass settles at its close: its record pull request still counts (spec §5.3).
  const holds =
    below.state === PassState.Closed ||
    (below.state === PassState.Settled &&
      getProject(db, below.projectId).delivery !== Delivery.PullRequest);
  return holds && !merged && branch !== null ? branch : batch.baseBranch;
}

/** The titles of the pass's signed-off pages, in the order they joined it. */
function signedOffTasks(db: DbReader, passId: PassId) {
  return listPassTasks(db, passId).filter(
    (task) =>
      task.workstreamId !== null &&
      getWorkstream(db, task.workstreamId).state === WorkstreamState.Done,
  );
}

function signedOff(db: DbReader, passId: PassId): string[] {
  return signedOffTasks(db, passId).map((task) => task.title);
}

/** The header notice of a failed gate on the pass's tip, a close's included. */
export const PASS_GATE_NOTICE = 'gate';
/** The header notice that says Open Pull Request did not finish. */
const PR_OPEN_NOTICE = 'pr-open';

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function createPassPullRequests(deps: PassPullRequestDeps): PassPullRequests {
  const db = deps.state.db;
  /**
   * How each pass's body says it was checked, as its last gate left it. A pass with none here has
   * had no gate finish in this daemon's life.
   */
  const checked = new Map<PassId, PassPrCheck>();
  /**
   * The pushed commit of each pass whose gate Open Pull Request is about to start, or is running:
   * set before the draft it writes, and gone on every way out (the gate's end, a failure before it
   * started, checks that ended without a gate, a stop). Each Open Pull Request has a mark of its
   * own, and `run` is the abort signal of the checks it handed the gate to, so the end of an older
   * gate of the same commit never takes a newer one's mark.
   */
  const gating = new Map<PassId, { readonly sha: string; run: AbortSignal | null }>();

  function checkOf(pass: PassDto, project: ProjectDto, sha: string): PassPrCheck {
    const command = shipCheck(project)?.command;
    const running = gating.get(pass.id);
    if (running !== undefined && passGateKind(project) === PassPullRequestGate.Scratch)
      return { kind: 'scratch', command: command ?? '', sha: running.sha, state: 'running' };
    const known = checked.get(pass.id);
    if (known) return known;
    switch (passGateKind(project)) {
      case PassPullRequestGate.None:
        return { kind: 'none' };
      case PassPullRequestGate.FolderAtClose:
        return { kind: 'folder_at_close', command: command ?? '' };
      case PassPullRequestGate.Scratch:
        return { kind: 'scratch', command: command ?? '', sha, state: 'unknown' };
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
    /** The end of the gate's log; empty when it did not run. */
    tail: string;
    dirtyNamed: readonly string[];
  }> {
    const { pass, batch, project } = placeOf(i.passId);
    const command = shipCheck(project)?.command ?? '';
    const beforeStart = () => Promise.resolve(deps.holdShips?.() !== true);
    if (i.where === 'folder') {
      const result = await runGate(deps, batch, project, i.signal, beforeStart);
      if (result === null)
        return { passed: false, aborted: true, logPath: '', tail: '', dirtyNamed: [] };
      const dirty = await deps.git.changedPaths(project.repoPath);
      const passed = result.exitCode === 0;
      checked.set(pass.id, { kind: 'folder', command, passed, dirty });
      // Only a close gates in the folder: its failure's notice is the close's to write, once the
      // pass has reopened.
      if (passed) deps.state.write((w) => clearPassNotice(w, pass.id, PASS_GATE_NOTICE));
      return {
        passed,
        aborted: false,
        logPath: result.logPath,
        tail: result.tail,
        dirtyNamed: dirty,
      };
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
      return { passed: false, aborted: true, logPath: '', tail: '', dirtyNamed: [] };
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
        clearPassNotice(w, pass.id, PASS_GATE_NOTICE);
        return;
      }
      setPassNotice(w, pass.id, {
        id: PASS_GATE_NOTICE,
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
    const tail = ran.kind === 'ran' ? ran.result.tail : '';
    return { passed, aborted: false, logPath, tail, dirtyNamed: [] };
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

  /**
   * With the project's setting on, pushes the signed-off pages' before and after pictures to the pass's
   * `10db-pictures/<pass id>` branch of origin and answers the body's Pictures section. A pull request
   * never waits on its pictures: any failure is logged and the section left out.
   */
  async function picturesFor(passId: PassId, repo: string, signal: AbortSignal): Promise<string> {
    const { pass, project } = placeOf(passId);
    if (!project.prPictures) return '';
    const plan = picturePlan(
      signedOffTasks(db, passId).map((task) => ({
        title: task.title,
        screens: listTaskScreens(db, task.id),
      })),
    );
    if (plan.length === 0) return '';
    try {
      const email = await deps.gh.noreplyEmail(ghCall(deps, signal));
      const files = plan
        .flatMap((pair) => [pair.before, pair.after])
        .flatMap((picture) =>
          picture === null
            ? []
            : [{ name: picture.name, path: getTaskScreenRow(db, picture.screen.id).storedPath }],
        );
      const sha = await deps.git.picturesCommit(project.repoPath, {
        files,
        author: { name: '10db', email },
        message: `Pictures for ${pass.name}`,
      });
      await deps.git.pushCommitTo(
        project.repoPath,
        sha,
        `10db-pictures/${pass.id}`,
        pushCall(deps, signal),
      );
      return picturesSection(repo, sha, plan);
    } catch (error) {
      deps.logger.warn(
        { passId, error: message(error) },
        'the pass pull request goes without its pictures',
      );
      return '';
    }
  }

  async function writeBody(
    passId: PassId,
    sha: string,
    repo: string,
    signal: AbortSignal,
  ): Promise<string> {
    const { pass, batch, project } = placeOf(passId);
    const file = join(deps.dataDir, 'delivery', `${batch.id}-pr-body.md`);
    mkdirSync(dirname(file), { recursive: true });
    const pictures = await picturesFor(passId, repo, signal);
    writeFileSync(
      file,
      [
        passPrBody({
          pass,
          pages: signedOff(db, passId),
          check: checkOf(pass, project, sha),
          ci: { repo, sha },
          template: await readPrTemplate(deps.git, project.repoPath, sha, deps.logger),
          reviewCut: getPassProgress(db, passId).notices.some((n) => n.id === REVIEW_CUT_NOTICE),
        }),
        pictures,
      ]
        .filter((part) => part !== '')
        .join('\n\n'),
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
    const bodyFile = await writeBody(pass.id, sha, repo, signal);
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
    // GitHub may have merged it before the watch read it: a merged pull request takes no more
    // commits, so what the branch holds since goes to a follow-on pull request.
    if ((await deps.gh.prView({ repo, ref: url }, call))?.state === PrState.Merged) {
      // Merged as the branch is now: nothing is left for a follow-on, and the watch marks it merged.
      await deps.git.fetch(project.repoPath, batch.baseBranch, networkCall(deps, signal));
      const base = await deps.git.trackingTip(project.repoPath, batch.baseBranch);
      if (
        base !== null &&
        (await deps.git.filesChangedBetween(project.repoPath, base, sha)).length === 0
      )
        return { url };
      return followOn(pass.id, signal, true);
    }
    await deps.gh.prEditBody({ repo, url, bodyFile }, call);
    if (i.ready && found.draft !== false) {
      await deps.gh.prReady({ repo, url }, call);
      deps.state.write((w) => {
        setPassPullRequest(w, pass.id, { url, draft: false });
      });
    }
    return { url };
  }

  function openFollowOnPr(passId: PassId, signal: AbortSignal): Promise<{ url: string } | null> {
    return followOn(
      passId,
      signal,
      getPassPullRequest(db, passId)?.state === PullRequestState.Merged,
    );
  }

  /**
   * Pushes the pass's branch and opens a pull request for what it holds beyond the one that merged
   * (`merged`), which it forgets first; with none merged, ensures the one it has.
   */
  async function followOn(
    passId: PassId,
    signal: AbortSignal,
    merged: boolean,
  ): Promise<{ url: string } | null> {
    const { pass, batch, project } = placeOf(passId);
    const branch = batch.branch;
    if (branch === null || batch.repo === null) return null;
    const repo = project.repoPath;
    if ((await deps.git.remoteUrl(repo, 'origin')) === null) return null;
    // The base as GitHub merged it: when its tree is the pushed tip's, it comes into the branch by a
    // merge that changes no file, so the follow-on pull request shows only what came after.
    const pushed = await deps.git.trackingTip(repo, branch);
    await deps.git.fetch(repo, batch.baseBranch, networkCall(deps, signal));
    const base = await deps.git.trackingTip(repo, batch.baseBranch);
    if (
      pushed !== null &&
      base !== null &&
      (await deps.git.filesChangedBetween(repo, base, pushed)).length === 0
    )
      await deps.git.mergeKeepingTree({
        repo,
        branch,
        theirs: base,
        message: `Merge ${batch.baseBranch}, which holds the merged pull request of pass "${pass.name}", into ${branch}`,
      });
    // The merged pull request is history: the follow-on takes its place on the batch. Forgotten
    // before the push, so a restart between them still opens the follow-on.
    if (merged)
      deps.state.write((w) => {
        forgetPassPullRequest(w, passId);
      });
    await pushPassBranch(passId, signal);
    return ensurePassPr({ passId, ready: true }, signal);
  }

  /** Rewrites the pull request's body from the rows; one gh can't edit keeps the lines it had. */
  async function rewriteBody(passId: PassId, sha: string, signal: AbortSignal): Promise<void> {
    const { batch } = placeOf(passId);
    const pr = getPassPullRequest(db, passId);
    if (pr === null || batch.repo === null) return;
    const bodyFile = await writeBody(passId, sha, batch.repo, signal);
    await deps.gh
      .prEditBody({ repo: batch.repo, url: pr.url, bodyFile }, ghCall(deps, signal))
      .catch((error: unknown) => {
        deps.logger.warn({ passId, err: message(error) }, 'pass pull request body not updated');
      });
  }

  const checks = createPassChecks({
    ...deps,
    gate: async ({ passId, sha, signal }) => {
      try {
        await gatePassTip({ passId, sha, where: 'scratch', signal });
      } catch (error) {
        // It could not run: no result of it is known, and the body says so.
        checked.delete(passId);
        throw error;
      } finally {
        if (gating.get(passId)?.run === signal) gating.delete(passId);
        // The body says how the gate went; a shutdown or a close that stopped it writes nothing. A
        // body that cannot be written is logged, so the gate's own error is the one that is told.
        if (!signal.aborted)
          await rewriteBody(passId, sha, signal).catch((error: unknown) => {
            deps.logger.warn({ passId, err: message(error) }, 'pass pull request body not updated');
          });
      }
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
    // Its work is in the base: the pass closes by itself (call 6).
    if (pr?.state === PullRequestState.Merged)
      return refuse("The pass's pull request has merged; 10db closes the pass", ahead);
    if (tip === null || tip === pass.startSha) {
      // A page signed off with no change of its own lands no commit, so the branch can stay where it
      // started with pages signed off.
      const signedOff = listPassTasks(db, passId).some(
        (task) =>
          task.workstreamId !== null &&
          getWorkstream(db, task.workstreamId).state === WorkstreamState.Done,
      );
      return refuse(
        signedOff
          ? 'The signed-off pages changed no file: the pull request holds their changes only'
          : 'Nothing is signed off yet: the pull request holds signed-off pages only',
        ahead,
      );
    }
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
    openFollowOnPr,
    async stopPassChecks(passId) {
      await checks.stop(passId);
      gating.delete(passId);
    },
    preview,
    async open(passId) {
      const shown = await preview(passId);
      if (!shown.offered)
        throw new ConflictError(shown.reason ?? 'Open Pull Request is not offered');
      const { pass, batch, project } = placeOf(passId);
      const branch = batch.branch;
      const tip = branch === null ? null : await deps.git.branchTip(project.repoPath, branch);
      const reviewed = getPassProgress(db, passId).reviewedSha;
      // A tip read already, with nothing a cut review left unread, is not reviewed again.
      const unchanged = (sha: string | null): boolean =>
        getPassProgress(db, passId).reviewedSha === sha && !reviewHasUnread(db, passId);
      const review =
        deps.review === null || !passHasReview(db, passId)
          ? 'none'
          : reviewed !== null && unchanged(tip)
            ? 'unchanged'
            : 'started';
      const stillOpen = (): boolean => getPass(db, passId).state === PassState.Open;
      const reviews = review !== 'none';
      const gates = shown.gate === PassPullRequestGate.Scratch;
      deps.jobs.run(jobKey(batch, JobQueue.Ship), async (signal) => {
        if (signal.aborted || getPass(db, passId).state !== PassState.Open || branch === null)
          return;
        // This job's mark of the commit about to be gated, and whether the checks took the gate
        // on, whose end clears the mark.
        let marked: { readonly sha: string; run: AbortSignal | null } | null = null;
        let handed = false;
        try {
          if ((await pushPassBranch(passId, signal)) === 'no_origin') return;
          const sha = await deps.git.branchTip(project.repoPath, branch);
          // An Abandon or a close that took the pass while the branch was pushed: no pull request,
          // and no gate or review, is started for it.
          if (sha === null || !stillOpen()) return;
          // The gate starts once the pull request is there: its body says the gate is running.
          if (gates) {
            marked = { sha, run: null };
            gating.set(passId, marked);
          }
          await ensurePassPr({ passId, ready: false }, signal);
          deps.state.write((w) => clearPassNotice(w, passId, PR_OPEN_NOTICE));
          if (!stillOpen()) return;
          const started = checks.start({
            passId,
            sha,
            gate: gates,
            // Decided on the tip pushed: a page that landed since the request makes it new.
            review: reviews && !unchanged(sha),
            baseRef: `refs/remotes/origin/${shown.base}`,
          });
          const mark = marked;
          if (mark !== null) {
            handed = true;
            mark.run = started.signal;
            // Checks that end without running the gate (stopped, or the pass gone meanwhile) leave
            // no mark behind.
            void started.done.finally(() => {
              if (gating.get(passId) === mark) gating.delete(passId);
            });
          }
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
        } finally {
          if (!handed && marked !== null && gating.get(passId) === marked) gating.delete(passId);
        }
      });
      return { url: shown.existing?.url ?? null, base: shown.base, gate: shown.gate, review };
    },
    async stop() {
      await checks.stopAll();
      gating.clear();
    },
  };
}
