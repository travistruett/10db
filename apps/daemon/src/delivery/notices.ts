import type { BatchDto, Notice } from '@10db/contracts';
import { worktreeMergeCommand, worktreeRestoreCommand } from '../git';
import { detailOf, inSteps, listPaths, RERAN, testLines } from './cards';
import type { GateStepFailure } from './gate-failures';
import type { TakenNumber } from './migration-numbers';

/**
 * What a batch's tasks show on their cards and drawers while something stands that asks the builder
 * nothing: the branch can't take its base yet, or its pull request waits to be merged by hand. Each is
 * a `Notice` on the batch, written when the cause is found and cleared when it is gone. Writing the same
 * notice again changes nothing, so a gate that meets the same cause again raises nothing and tells no
 * one (`decisions/2026-10-31-notices-not-cards.md`).
 */
export const NOTICE_KEY = {
  /** The branch conflicts with its base. */
  baseConflict: 'base-conflict',
  /** Files git doesn't track keep the base out. */
  baseKept: 'base-kept',
  /** A lane launched without the base's newer commits because origin could not be fetched. */
  baseFetch: 'base-fetch',
  /** A lane launched without the base's newer commits because uncommitted changes were in the way. */
  baseUncommitted: 'base-uncommitted',
  /** The pull request waits for the builder to merge it. */
  merge: 'pull-request-merge',
  /** The shipping gate failed once, in tests the batch didn't change, and passed when run again. */
  gateRerun: 'gate-rerun',
  /** 10db merged the base into the open pull request's branch. */
  update: 'pull-request-update',
  /** The branch the batch lands in lacks commits the project's base branch has. */
  landingBehind: 'landing-behind',
  /** The branch the batch lands in is used by no other task under way or unfinished batch, and isn't the project's base. */
  landingUnused: 'landing-unused',
  /** The batch is a landing's second, because the landing's earlier batch had already shipped. */
  landingShipped: 'landing-shipped',
  /** A copy was cut without the ignored directories a seed clones, and 10db could not make them. */
  seedSkipped: 'seed-skipped',
  /** A copy's install skipped the install scripts of packages the project allows to build. */
  scriptsSkipped: 'install-scripts-skipped',
  /** The pull request's head has no run of the checks GitHub requires, and 10db could not start them. */
  checksNeverStarted: 'checks-never-started',
  /** A required check GitHub cancelled stayed cancelled after 10db ran it again, or 10db could not run it again. */
  checksCancelled: 'checks-cancelled',
  /**
   * 10db ran a cancelled required check again. The key ends in `:` and the head it ran for, so a
   * restarted daemon reads that head as already asked and never runs it a second time.
   */
  checksRerun: 'checks-rerun',
  /** A task started over from a failed attempt whose commits are still on the batch's branch. */
  supersededAttempt: 'superseded-attempt',
  /** The install before a gate left the copy broken, and 10db removed node_modules and installed again. */
  installRepaired: 'install-repaired',
} as const;

/** What a batch's tasks are told about an install 10db repaired by itself. */
export const installNotices = {
  /** The first install before a gate left the copy broken; a check after the second found it whole. */
  repaired: (unresolved: string, at: Date): Notice => {
    const when = `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    return {
      key: NOTICE_KEY.installRepaired,
      tone: 'info',
      line: `The install in this copy was repaired at ${when}`,
      body: `The install before the gate left this copy's packages broken (${unresolved}). At ${when} 10db removed node_modules and installed again from the lockfile. A check after that found every package resolved, so the step went on with no card and no attempt counted.`,
    };
  },
};

/**
 * What a batch's tasks are told when tasks in it failed, started over in a run of their own, and
 * left their failed attempts' commits on the batch's branch: those commits are unverified, so the
 * batch doesn't ship by itself, and Ship anyway would put them in its pull request.
 */
export const supersededNotices = {
  committed: (batch: BatchDto, titles: readonly string[]): Notice => {
    const named = titles.map((t) => `"${t}"`).join(', ');
    const one = titles.length === 1;
    return {
      key: NOTICE_KEY.supersededAttempt,
      tone: 'warning',
      line: `${named} started over; ${one ? 'its' : 'their'} failed attempt${one ? '' : 's'}' commits are still on this branch`,
      body: `${named} failed in this batch and ${one ? 'was' : 'were'} started over in a new run, which does the work again from ${batch.baseBranch}. Nothing will run the failed attempt${one ? '' : 's'} again, but the commits ${one ? 'it' : 'they'} made are still on ${batch.branch ?? "the batch's branch"}, and no gate or review passed them. So this batch doesn't ship by itself.\n\nShip anyway puts those commits in the pull request with the other tasks' work, and the new run may then conflict with them or repeat them. To keep them out, revert them on the branch first, then Ship anyway, or abandon the batch.`,
    };
  },
  /**
   * The batch holds a failed attempt that left no commits, because the fresh start meant to replace
   * it was refused: nothing runs the task now, and the batch waits so the builder can start again.
   */
  refusedStart: (titles: readonly string[]): Notice => {
    const named = titles.map((t) => `"${t}"`).join(', ');
    const one = titles.length === 1;
    return {
      key: NOTICE_KEY.supersededAttempt,
      tone: 'warning',
      line: `${named} failed here and ${one ? 'its' : 'their'} start over was refused: this batch is waiting`,
      body: `${named} failed in this batch and ${one ? 'was' : 'were'} started over, but that new start was refused, so nothing is running ${one ? 'it' : 'them'} now. This batch keeps the failed attempt${one ? '' : 's'} so ${one ? 'it' : 'they'} can still be retried, and doesn't ship by itself.\n\nStart ${one ? 'the task' : 'the tasks'} again to retry, or Ship anyway to ship the other tasks' work without ${one ? 'it' : 'them'}. Closing ${one ? 'the task' : 'the tasks'} lets the batch ship the rest by itself.`,
    };
  },
};

/**
 * What a copy's tasks are told when its cut skipped the seed because Your folder had an unfinished
 * shared batch, and the install did not make every directory the seed would have cloned.
 */
/** How many unbuilt packages the install-scripts notice names before it counts the rest. */
const SCRIPTS_SKIPPED_SHOWN = 10;

/** Why a copy holds no built output: its cut skipped the seed, or 10db removed its `node_modules`. */
export type UnbuiltWhy = 'seed_skipped' | 'started_over';

export const seedNotices = {
  skipped: (dirs: readonly string[]): Notice => {
    const named = dirs.join(', ');
    return {
      key: NOTICE_KEY.seedSkipped,
      tone: 'warning',
      line: `This copy has no ${named}: Your folder had a batch open when it was made`,
      body: `A new copy usually gets a clone of Your folder's ignored ${dirs.length === 1 ? 'directory' : 'directories'} ${named}. A task in Your folder was unfinished when this copy was made, and a lane there can write those directories, so 10db cloned nothing into the copy. 10db can only rebuild node_modules, and only in a pnpm project, so ${named} ${dirs.length === 1 ? 'is' : 'are'} missing from the copy, and its gate may fail on that.\n\nTo get them, abandon this batch and start the task again once Your folder's batch has shipped or been abandoned, or make them in the copy yourself.`,
    };
  },
  /**
   * The install made `node_modules` but ran no install script, and the built output a seed carries
   * is not in the copy, so these packages the project allows to build are unbuilt. `why` says where
   * the built output went: the cut skipped the seed, or 10db removed the `node_modules` that held it.
   */
  scriptsSkipped: (names: readonly string[], why: UnbuiltWhy, legacyPnpmMajor?: number): Notice => {
    const shown = names.slice(0, SCRIPTS_SKIPPED_SHOWN);
    const rest = names.length - shown.length;
    const named = rest > 0 ? `${shown.join(', ')} and ${String(rest)} more` : shown.join(', ');
    const one = names.length === 1;
    // pnpm rebuild with no names rebuilds every package, so a long list needn't be typed out.
    const rebuild = rest > 0 ? 'pnpm rebuild' : `pnpm rebuild ${named}`;
    const allows =
      legacyPnpmMajor === undefined
        ? `The project lets ${named} run ${one ? 'its' : 'their'} install script (allowBuilds),`
        : `The copy was installed with pnpm ${String(legacyPnpmMajor)}, which builds every dependency that has an install script unless the project limits it, ${named} included,`;
    const cause =
      why === 'seed_skipped'
        ? 'A task in Your folder was unfinished when this copy was made, so 10db cloned nothing into it, and the install that made its node_modules runs no repository code, install scripts included.'
        : "This copy's node_modules was made by another version of pnpm than the one 10db runs, or had packages missing, so 10db removed it and installed it from nothing, and that install runs no repository code, install scripts included.";
    const otherwise =
      why === 'seed_skipped'
        ? ", or abandon this batch and start the task again once Your folder's batch has shipped or been abandoned"
        : '';
    return {
      key: NOTICE_KEY.scriptsSkipped,
      tone: 'warning',
      line: `${named} ${one ? 'is' : 'are'} not built in this copy: its install ran without install scripts`,
      body: `${allows} and a new copy usually gets Your folder's built output for ${one ? 'it' : 'them'}. ${cause} ${one ? 'This package is' : 'These packages are'} installed but not built (a native addon, a generated client, a downloaded binary), and the copy's gate may fail on that.\n\nTo build ${one ? 'it' : 'them'}, run ${rebuild} in the copy${otherwise}.`,
    };
  },
};

/** What a batch's tasks are told when the branch they land in has fallen behind the project's base. */
export const landingNotices = {
  /** A task of a landing started after the landing's batch shipped, so it makes a pull request of its own. */
  shipped: (landing: string, shipped: string): Notice => ({
    key: NOTICE_KEY.landingShipped,
    tone: 'info',
    line: `Part of ${landing}, which has already shipped`,
    body: `This task belongs to the landing ${landing}, whose pull request (batch "${shipped}") has already shipped, so it can't join it. It makes a new batch and its own pull request, with its own CI run.`,
  }),
  behind: (branch: string, base: string, missing: number): Notice => ({
    key: NOTICE_KEY.landingBehind,
    tone: 'warning',
    line: `${branch} lacks ${String(missing)} commit${missing === 1 ? '' : 's'} ${base} has`,
    body: `This work lands in ${branch}, and is built from it, but origin/${branch} doesn't hold ${String(missing)} commit${missing === 1 ? '' : 's'} that origin/${base} has, so the batch lacks any fix made there. Work landed in ${branch} also won't reach ${base} unless ${branch} is merged into it.\n\nIf ${branch} is no longer in use, change where this task lands to the base and start it again. Otherwise merge ${base} into ${branch} on origin first.`,
  }),
  /** The branch is not the project's default, and no other task under way or unfinished batch lands in it. */
  unused: (branch: string, base: string): Notice => ({
    key: NOTICE_KEY.landingUnused,
    tone: 'warning',
    line: `Nothing else under way lands in ${branch}`,
    body: `This work lands in ${branch}, which isn't ${base}, the project's base branch, and no other task under way or unfinished batch lands in it. Tasks only filed against it, not started, don't count. A branch kept for a run of work is often retired once its last piece merges, and work landed in a retired branch never reaches ${base}.\n\nIf ${branch} is still in use, carry on. If it is retired, change where this task lands to the base and start it again.`,
  }),
};

/** Why a base notice was written beyond the gate, and what more it found. */
export interface BaseNoticeContext {
  /** The task that asked for the migrations hazard, which 10db holds back until the branch holds its base. */
  readonly migrationsFor?: string;
  /** The branch's migrations whose number the base already gives another. */
  readonly taken?: readonly TakenNumber[];
  /** Why each conflicting path stayed a conflict, when 10db tried to settle it. */
  readonly reasons?: ReadonlyMap<string, string>;
}

/** What a task held back from the migrations hazard is told, after the first paragraph. */
function migrationsHeld(batch: BatchDto, context: BaseNoticeContext, until: string): string {
  return context.migrationsFor === undefined
    ? ''
    : `\n\nTask "${context.migrationsFor}" asked for the migrations hazard. 10db gives it only once this branch holds ${batch.baseBranch}, so that a migration it generates is numbered after ${batch.baseBranch}'s latest: until ${until}, the task generates no migration.`;
}

/** The migrations a conflict renumbers, in a line: "migration 0009_x" or "migrations 0009_x, 0010_y". */
function migrationNames(taken: readonly TakenNumber[]): string {
  const tags = [...new Set(taken.map((t) => t.ours))];
  return `${tags.length === 1 ? 'migration' : 'migrations'} ${tags.join(', ')}`;
}

/** How the builder makes the branch's migrations again on top of the base, step by step. */
function regenerateSteps(batch: BatchDto, worktree: string, taken: readonly TakenNumber[]): string {
  const base = batch.baseBranch;
  const dirs = [...new Set(taken.map((t) => t.dir))];
  const named = dirs.map((d) => `${d}/`).join(' and ');
  const each = taken
    .map(
      (t) =>
        `Migration ${t.ours} takes number ${t.number}, which ${base}'s ${t.theirs} already has.`,
    )
    .join('\n');
  const restores = dirs.map((d) => worktreeRestoreCommand(worktree, base, d)).join(', then ');
  return `${each}\n\nMigrations are numbered in order, and ${named} is generated, so it is never merged by hand: the batch's migration has to be generated again on top of ${base}. In the worktree:\n1. ${worktreeMergeCommand(worktree, base)}, which stops at the conflict.\n2. ${restores}, which takes ${base}'s migrations whole and drops the batch's own.\n3. Run drizzle-kit generate the way the project does, in the package that holds ${named}, so the batch's schema change becomes the migration after ${base}'s latest.\n4. Resolve any other file listed above, then git add and git commit, with hooks off as in step 1.\n\nUntil then the gates test the branch without ${base}'s newer commits. The next gate tests the result, and this notice goes once the branch holds ${base}.`;
}

/** A few paths for a card's one line. */
const LINE_PATHS = 3;

function shortPaths(paths: readonly string[]): string {
  const more = paths.length - LINE_PATHS;
  return `${paths.slice(0, LINE_PATHS).join(', ')}${more > 0 ? ` and ${String(more)} more` : ''}`;
}

/** What delivery shows on a worktree batch's tasks when its branch can't take its base before a gate. */
export const baseNotices = {
  /**
   * `worktree` is the batch's worktree, where the builder can merge by hand. A conflict that renumbers
   * a migration says how to generate it again instead of how to merge.
   */
  conflict: (
    batch: BatchDto,
    worktree: string,
    paths: readonly string[],
    context: BaseNoticeContext = {},
  ): Notice => {
    const taken = context.taken ?? [];
    const reasons = context.reasons ?? new Map<string, string>();
    const conflicting = `${batch.baseBranch} on origin changed these files in ways that conflict with the batch's own changes, and 10db couldn't settle them itself:\n${listPaths(paths.map((p) => (reasons.has(p) ? `${p}: ${reasons.get(p) ?? ''}` : p)))}`;
    const held = migrationsHeld(batch, context, 'the conflict is resolved');
    return {
      key: NOTICE_KEY.baseConflict,
      tone: 'warning',
      line:
        taken.length > 0
          ? `Must regenerate ${migrationNames(taken)} on top of ${batch.baseBranch}`
          : `Conflicts with ${batch.baseBranch}: ${shortPaths(paths)}`,
      body:
        taken.length > 0
          ? `${conflicting}${held}\n\n${regenerateSteps(batch, worktree, taken)}`
          : `${conflicting}${held}\n\nBefore each gate 10db merges ${batch.baseBranch} into the batch's branch, so the gate tests what the pull request would merge. It settles a conflict by itself when both sides only added lines at the same place, and regenerates the generated directories it knows the generator of; anything else needs a choice. A lane commits only its own files and never records a merge, so it can't make it. Until the conflict is resolved, the gates test the branch without ${batch.baseBranch}'s newer commits, so a failure they fix still shows.\n\nOnce the pull request is open, resolve it there (GitHub's Update branch, then Resolve conflicts). Or merge it yourself in the worktree: ${worktreeMergeCommand(worktree, batch.baseBranch)}. That command turns the repository's hooks off, because lanes write in the worktree, so the hook config there is theirs to choose. The next gate tests the result, and this notice goes once the branch holds ${batch.baseBranch}.`,
    };
  },
  /**
   * 10db merged the base into the branch and left git's conflict markers in `paths` for a session to
   * resolve: nothing is asked of the builder, and no gate runs until the markers are gone. Replaces
   * the conflict notice, which it shares a key with; the next merge that finds the branch holding the
   * base clears it.
   */
  resolving: (batch: BatchDto, paths: readonly string[]): Notice => ({
    key: NOTICE_KEY.baseConflict,
    tone: 'info',
    line: `Resolving conflicts with ${batch.baseBranch}: ${shortPaths(paths)}`,
    body: `${batch.baseBranch} on origin changed these files in ways that overlap the batch's own changes. 10db merged ${batch.baseBranch} into the batch's branch and left git's conflict markers in them for a session to resolve:\n${listPaths(paths)}\n\nThe session keeps both sides' work and commits the resolution; no gate runs on the branch until the markers are gone, so a gate never tests a branch without ${batch.baseBranch}'s newer commits. The builder is asked only if a resolution would change what either side does. This notice goes once the markers are resolved.`,
  }),
  /**
   * The batch shipped with its branch still in conflict with its base, and the worktree that held the
   * merge is gone: the open pull request conflicts, and only the builder can resolve it.
   */
  shippedConflict: (batch: BatchDto): Notice => ({
    key: NOTICE_KEY.baseConflict,
    tone: 'warning',
    line: `Pull request conflicts with ${batch.baseBranch}`,
    body: `${batch.baseBranch} on origin changed files in ways that conflict with the batch's own changes, and the batch shipped anyway: the pull request${batch.prUrl === null ? '' : ` (${batch.prUrl})`} can't merge until the conflict is resolved.\n\nResolve it on GitHub (Update branch, then Resolve conflicts). 10db never resolves a conflict in a pull request.`,
  }),
  /**
   * A lane launched on the batch's copy as it is, because the base could not be fetched: anything
   * that merged into the base since the copy was cut is not in it. The next fetch that works clears it.
   */
  fetchFailed: (batch: BatchDto, error: unknown): Notice => ({
    key: NOTICE_KEY.baseFetch,
    tone: 'warning',
    line: `Couldn't fetch ${batch.baseBranch}: this lane started on the copy as it is`,
    body: `10db brings ${batch.baseBranch} into a batch's copy when a lane launches, so the lane sees what merged while it waited. It couldn't fetch ${batch.baseBranch} from origin (${detailOf(error)}), so this lane started on the copy as it is, without any commits that merged into ${batch.baseBranch} since the copy was cut.\n\nThe next launch or gate fetches again, and this notice goes once a fetch works.`,
  }),
  /**
   * A lane launched on the batch's copy without the base's newer commits, because uncommitted changes
   * in `paths` (most likely another task's, mid-session) are in the way of the merge. The next launch
   * or gate that can take the base clears it.
   */
  uncommitted: (batch: BatchDto, paths: readonly string[]): Notice => ({
    key: NOTICE_KEY.baseUncommitted,
    tone: 'warning',
    line: `Uncommitted changes in ${shortPaths(paths)}: this lane started without ${batch.baseBranch}’s newer commits`,
    body: `10db brings ${batch.baseBranch} into a batch's copy when a lane launches, so the lane sees what merged while it waited. Uncommitted changes, most likely another task's of this batch that is still working, are in files ${batch.baseBranch} has changed:\n${listPaths(paths)}\n\n10db never overwrites them, so it didn't merge ${batch.baseBranch}, and this lane started without the newer commits on ${batch.baseBranch}. It may build on code that has since changed there.\n\nThe next launch or gate tries again once those changes are committed, and this notice goes once the branch holds ${batch.baseBranch}.`,
  }),
  /** `worktree` is the batch's worktree, which holds `paths`. */
  kept: (
    batch: BatchDto,
    worktree: string,
    paths: readonly string[],
    context: BaseNoticeContext = {},
  ): Notice => ({
    key: NOTICE_KEY.baseKept,
    tone: 'warning',
    line: `Can't take ${batch.baseBranch}: files git doesn't track are in the way (${shortPaths(paths)})`,
    body: `${batch.baseBranch} on origin adds files where the batch's worktree ${worktree} holds files git doesn't track, most likely ignored ones such as a hand-made .env or a build directory:\n${listPaths(paths)}${migrationsHeld(batch, context, 'they are out of the way')}\n\n10db never overwrites or deletes them, so it didn't merge ${batch.baseBranch}, and the gates test the branch without its newer commits. A fix session is told to leave them. If you don't need them, move or delete them; otherwise leave the merge to the pull request. The next gate tries again, and this notice goes once the branch holds ${batch.baseBranch}.`,
  }),
};

/** What delivery shows on a batch's tasks about a shipping gate that needed no answer from the builder. */
export const gateNotices = {
  /** The second run 10db made by itself passed, and the batch went on to ship. */
  rerunPassed: (steps: readonly GateStepFailure[]): Notice => ({
    key: NOTICE_KEY.gateRerun,
    tone: 'info',
    line: 'The gate passed when 10db ran it again',
    body: `The shipping gate's first run failed${inSteps(steps)}. ${RERAN}, and it passed, so the batch went on to ship. These tests may be flaky:\n${testLines(steps)}`,
  }),
};

/** What delivery shows on a shipped batch's tasks about its pull request's required checks. */
export const ciNotices = {
  /** The head has no check at all while GitHub waits for a required one, and starting CI again did not help or is not 10db's to do. */
  neverStarted: (batch: BatchDto): Notice => {
    const prUrl = batch.prUrl;
    const number = prUrl === null ? null : /\/pull\/(\d+)$/.exec(prUrl)?.[1];
    const named =
      number === undefined || number === null ? 'the pull request' : `pull request #${number}`;
    return {
      key: NOTICE_KEY.checksNeverStarted,
      tone: 'warning',
      line: `Checks never started on ${named}`,
      body: `GitHub waits for the required checks of ${batch.baseBranch}, but the head of ${named}${prUrl === null ? '' : ` (${prUrl})`} has no run of them, minutes after it was pushed. GitHub skips a pull request's workflows when it cannot build the merge commit at push time, so the pull request waits for checks that will never come.\n\n${batch.autoMerge ? '10db tried to start them again by merging the base into the pull request, and they still did not start. ' : 'This pull request is held for you, so 10db pushes nothing to it. '}Push a commit to the branch, or merge ${batch.baseBranch} into it on GitHub (Update branch), to start the checks. This notice goes once any check appears on the head.`,
    };
  },
};

/** Why 10db stopped trying to get a cancelled required check to run. */
export type CancelledWhy =
  | { readonly kind: 'again' }
  | { readonly kind: 'no_run' }
  | { readonly kind: 'refused'; readonly detail: string };

/** What delivery shows on a shipped batch's tasks when a required check stays cancelled. */
export const cancelledNotices = {
  /** `checks` are the cancelled required checks; each is named with its link. */
  stuck: (
    batch: BatchDto,
    checks: readonly { readonly name: string; readonly link: string | null }[],
    why: CancelledWhy,
  ): Notice => {
    const prUrl = batch.prUrl;
    const number = prUrl === null ? null : /\/pull\/(\d+)$/.exec(prUrl)?.[1];
    const named =
      number === undefined || number === null ? 'the pull request' : `pull request #${number}`;
    const names = checks.map((c) => `"${c.name}"`).join(', ');
    const one = checks.length === 1;
    const list = checks.map((c) => `- ${c.name}${c.link === null ? '' : `: ${c.link}`}`).join('\n');
    const what = one ? `Required check ${names}` : `Required checks ${names}`;
    const it = one ? 'it' : 'them';
    let line: string;
    let tail: string;
    switch (why.kind) {
      case 'again':
        line = `${what} on ${named} was cancelled again`;
        tail = `10db ran ${it} again once and GitHub cancelled ${it} again, so 10db leaves ${it} alone now.`;
        break;
      case 'no_run':
        line = `${what} on ${named} was cancelled and can't be run again by 10db`;
        tail = `${one ? 'It is' : 'They are'} not a GitHub Actions job, so 10db has nothing to run again.`;
        break;
      case 'refused':
        line = `${what} on ${named} was cancelled and 10db could not run ${it} again`;
        tail = `GitHub refused to run ${it} again: ${why.detail.slice(0, 300)}`;
        break;
    }
    return {
      key: NOTICE_KEY.checksCancelled,
      tone: 'warning',
      line,
      body: `GitHub cancelled ${one ? 'a check' : 'checks'} that ${batch.baseBranch} requires, so ${named}${prUrl === null ? '' : ` (${prUrl})`} cannot merge.\n\n${list}\n\n${tail} Run ${one ? 'it' : 'them'} again from the link${one ? '' : 's'} above (Re-run jobs), or push a commit to the branch. This notice goes once the check runs again or passes.`,
    };
  },
};

/** The key of the rerun notice for one pull request head. */
export const rerunNoticeKey = (head: string): string => `${NOTICE_KEY.checksRerun}:${head}`;

/** The head a stored notice key says 10db ran a cancelled check for; null for any other key. */
export function rerunNoticeHead(key: string): string | null {
  const prefix = `${NOTICE_KEY.checksRerun}:`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : null;
}

/** The Actions runs GitHub took a rerun of for one head, each with the checks it reran. */
export type RerunRuns = ReadonlyMap<string, readonly { readonly name: string }[]>;

const RUNS_MARK = 'Runs 10db started (run id: its checks, then whether it is done): ';

/**
 * What a stored rerun notice records of the head: the runs GitHub took, and whether 10db is done
 * asking (a run GitHub refused as still running is asked again, also by a daemon that restarted).
 * Null when the notice carries no record (an older one: the head counts as fully asked).
 */
export function rerunRecord(
  notice: Notice,
): { runs: Map<string, { name: string }[]>; done: boolean } | null {
  const at = notice.body.lastIndexOf(RUNS_MARK);
  if (at < 0) return null;
  try {
    const parsed: unknown = JSON.parse(notice.body.slice(at + RUNS_MARK.length));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { runs, done } = parsed as { runs?: unknown; done?: unknown };
    if (typeof runs !== 'object' || runs === null || typeof done !== 'boolean') return null;
    const out = new Map<string, { name: string }[]>();
    for (const [runId, names] of Object.entries(runs)) {
      if (!Array.isArray(names) || !names.every((n): n is string => typeof n === 'string'))
        return null;
      out.set(
        runId,
        names.map((name) => ({ name })),
      );
    }
    return { runs: out, done };
  } catch {
    return null;
  }
}

/** What delivery shows on a shipped batch's tasks once it ran a cancelled required check again. */
export const rerunNotices = {
  /**
   * Also the record that the head was asked: it is read back after a restart. It names only the
   * checks of runs GitHub took, and `done` says there is no run left to ask for.
   */
  ran: (head: string, runs: RerunRuns, done: boolean): Notice => {
    const checks = [...runs.values()].flat();
    const names = checks.map((c) => `"${c.name}"`).join(', ');
    const one = checks.length === 1;
    const record = JSON.stringify({
      runs: Object.fromEntries([...runs].map(([runId, c]) => [runId, c.map((x) => x.name)])),
      done,
    });
    return {
      key: rerunNoticeKey(head),
      tone: 'info',
      line: `${one ? `Required check ${names} was` : `Required checks ${names} were`} cancelled; 10db ran ${one ? 'it' : 'them'} again`,
      body: `GitHub cancelled ${one ? 'a check' : 'checks'} that the base branch requires, so 10db ran ${one ? 'it' : 'them'} again once for this head (${head}). 10db runs it only once: if ${one ? 'it is' : 'they are'} cancelled again, a notice says so. ${done ? '' : 'Another cancelled run was still running, so 10db runs it as soon as GitHub allows. '}This notice goes when the pull request merges, closes or gets a new commit.\n\n${RUNS_MARK}${record}`,
    };
  },
};

/** What delivery shows on a shipped batch's tasks once 10db brought its base into the pull request. */
export const updateNotices = {
  /** The pull request conflicts, and a CI fix still running holds its branch, so the merge waits for it. */
  waiting: (batch: BatchDto): Notice => ({
    key: NOTICE_KEY.baseConflict,
    tone: 'warning',
    line: `Pull request conflicts with ${batch.baseBranch}; 10db merges it after the CI fix ends`,
    body: `${batch.baseBranch} on origin changed files in ways that conflict with the pull request${batch.prUrl === null ? '' : ` (${batch.prUrl})`}. A CI fix of it is still running in a checkout that holds the branch, so 10db can't merge ${batch.baseBranch} into it yet.\n\n10db tries again once that fix ends, and raises a card if it can't settle the conflict.`,
  }),
  /** 10db merged the base into the pull request because its head got none of the checks GitHub requires. */
  restarted: (
    batch: BatchDto,
    resolved: readonly { readonly path: string; readonly how: 'kept_both' | 'regenerated' }[],
  ): Notice => {
    const base = batch.baseBranch;
    const settled =
      resolved.length === 0
        ? ''
        : `\n\nThe merge settled these conflicts itself:\n${listPaths(resolved.map((r) => r.path))}`;
    return {
      key: NOTICE_KEY.update,
      tone: 'info',
      line: `10db merged ${base} into the pull request to start its checks`,
      body: `The head of the pull request${batch.prUrl === null ? '' : ` (${batch.prUrl})`} had no run of the checks ${base} requires, minutes after it was pushed, so it would have waited for them for ever. 10db merged ${base} into the batch's branch, checked the result as it checks a batch before it ships, and pushed it, so GitHub starts its workflows on the new head.${settled}\n\nIf the checks still do not start, 10db says so on this task.`,
    };
  },
  /** `resolved` are the conflicts 10db settled in the merge, by path and how. */
  merged: (
    batch: BatchDto,
    resolved: readonly { readonly path: string; readonly how: 'kept_both' | 'regenerated' }[],
  ): Notice => {
    const base = batch.baseBranch;
    const files =
      resolved.length === 0
        ? `Git merged ${base} without a conflict left to settle.`
        : `10db settled these conflicts itself:\n${listPaths(resolved.map((r) => `${r.path} (${r.how === 'regenerated' ? 'regenerated from its sources' : "both sides' added lines kept"})`))}`;
    return {
      key: NOTICE_KEY.update,
      tone: 'info',
      line:
        resolved.length === 0
          ? `10db merged ${base} into the pull request`
          : `10db merged ${base} into the pull request, resolving ${shortPaths(resolved.map((r) => r.path))}`,
      body: `The pull request${batch.prUrl === null ? '' : ` (${batch.prUrl})`} conflicted with ${base}. 10db merged ${base} into the batch's branch, checked the result as it checks a batch before it ships, and pushed it onto the pull request.\n\n${files}\n\nThe merge commit lists them. The pull request merges once GitHub has checked the new head.`,
    };
  },
};

/** gh's own words, cut so the notice keeps room for the link and the rest of what it says. */
const GH_WORDS_MAX = 4000;

function ghWords(error: unknown): string {
  const words = detailOf(error);
  return words.length <= GH_WORDS_MAX ? words : `${words.slice(0, GH_WORDS_MAX - 1)}…`;
}

/** What delivery shows on a shipped batch's tasks when its pull request can't merge by itself. */
export const mergeNotices = {
  /** The repository's own setting is off; every later pull request of the project waits the same way. */
  notAllowed: (repo: string, prUrl: string): Notice => ({
    key: NOTICE_KEY.merge,
    tone: 'warning',
    line: `Pull request waits for you to merge it: ${repo} doesn't allow auto-merge`,
    body: `GitHub's "Allow auto-merge" setting is off for ${repo}, so a pull request can't merge itself when its checks pass. The pull request is open and waits for you to merge it: ${prUrl}\n\nTurn on Allow auto-merge in ${repo}'s settings on GitHub (Settings, General, Pull Requests) and 10db will have later pull requests merge by themselves.`,
  }),
  /**
   * GitHub has nothing to wait for on the pull request and the base has no required checks, so only
   * the pre-check ever checked the work: 10db leaves the pull request open for the builder.
   */
  preCheckOnly: (batch: BatchDto, prUrl: string): Notice => ({
    key: NOTICE_KEY.merge,
    tone: 'warning',
    line: `Pull request waits for you to merge it: ${batch.baseBranch} has no required checks and only the pre-check ran`,
    body: `Batch "${batch.title}" was checked on the Mac by the project's pre-check, which stands in for the gate only where ${batch.baseBranch} has required checks on GitHub. It has none, so nothing but the pre-check would have checked this work, and 10db did not merge it.\n\nThe pull request is open and waits for you to merge it: ${prUrl}\n\nReview and merge it yourself, add required checks to ${batch.baseBranch}, or clear the project's pre-check in Settings › General to run the full gate again.`,
  }),
  /** GitHub turned this one pull request down, or gh could not ask. */
  refused: (prUrl: string, error: unknown): Notice => ({
    key: NOTICE_KEY.merge,
    tone: 'warning',
    line: 'Pull request waits for you to merge it: not set to merge by itself',
    body: `${ghWords(error)}\n\nThe pull request is open and waits for you to merge it: ${prUrl}`,
  }),
  /**
   * The pull request had nothing to wait for (its base branch has no required checks), so 10db
   * merged it at once; GitHub refused that merge.
   */
  mergeRefused: (batch: BatchDto, prUrl: string, error: unknown): Notice => ({
    key: NOTICE_KEY.merge,
    tone: 'warning',
    line: 'Pull request waits for you to merge it: GitHub refused to merge it',
    body: `${batch.baseBranch} has no required checks, so 10db tried to merge the pull request at once, and GitHub refused:\n\n${ghWords(error)}\n\nThe pull request is open and waits for you to merge it: ${prUrl}`,
  }),
};
