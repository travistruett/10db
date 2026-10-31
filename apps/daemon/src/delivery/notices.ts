import type { BatchDto, Notice } from '@10db/contracts';
import { worktreeMergeCommand, worktreeRestoreCommand } from '../git';
import { detailOf, listPaths } from './cards';
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
  /** The pull request waits for the builder to merge it. */
  merge: 'pull-request-merge',
} as const;

/** Why a base notice was written beyond the gate, and what more it found. */
export interface BaseNoticeContext {
  /** The task that asked for the migrations hazard, which 10db holds back until the branch holds its base. */
  readonly migrationsFor?: string;
  /** The branch's migrations whose number the base already gives another. */
  readonly taken?: readonly TakenNumber[];
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
    const conflicting = `${batch.baseBranch} on origin changed these files in ways that conflict with the batch's own changes:\n${listPaths(paths)}`;
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
          : `${conflicting}${held}\n\nBefore each gate 10db merges ${batch.baseBranch} into the batch's branch, so the gate tests what the pull request would merge. It can't resolve a conflict: a lane commits only its own files and never records a merge. Until the conflict is resolved, the gates test the branch without ${batch.baseBranch}'s newer commits, so a failure they fix still shows.\n\nOnce the pull request is open, resolve it there (GitHub's Update branch, then Resolve conflicts). Or merge it yourself in the worktree: ${worktreeMergeCommand(worktree, batch.baseBranch)}. That command turns the repository's hooks off, because lanes write in the worktree, so the hook config there is theirs to choose. The next gate tests the result, and this notice goes once the branch holds ${batch.baseBranch}.`,
    };
  },
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

/** What delivery shows on a shipped batch's tasks when its pull request can't merge by itself. */
export const mergeNotices = {
  /** The repository's own setting is off; every later pull request of the project waits the same way. */
  notAllowed: (repo: string, prUrl: string): Notice => ({
    key: NOTICE_KEY.merge,
    tone: 'warning',
    line: `Pull request waits for you to merge it: ${repo} doesn't allow auto-merge`,
    body: `GitHub's "Allow auto-merge" setting is off for ${repo}, so a pull request can't merge itself when its checks pass. The pull request is open and waits for you to merge it: ${prUrl}\n\nTurn on Allow auto-merge in ${repo}'s settings on GitHub (Settings, General, Pull Requests) and 10db will have later pull requests merge by themselves.`,
  }),
  /** GitHub turned this one pull request down, or gh could not ask. */
  refused: (prUrl: string, error: unknown): Notice => ({
    key: NOTICE_KEY.merge,
    tone: 'warning',
    line: 'Pull request waits for you to merge it: not set to merge by itself',
    body: `${detailOf(error)}\n\nThe pull request is open and waits for you to merge it: ${prUrl}`,
  }),
  /**
   * The pull request had nothing to wait for (its base branch has no required checks), so 10db
   * merged it at once; GitHub refused that merge.
   */
  mergeRefused: (batch: BatchDto, prUrl: string, error: unknown): Notice => ({
    key: NOTICE_KEY.merge,
    tone: 'warning',
    line: 'Pull request waits for you to merge it: GitHub refused to merge it',
    body: `${batch.baseBranch} has no required checks, so 10db tried to merge the pull request at once, and GitHub refused:\n\n${detailOf(error)}\n\nThe pull request is open and waits for you to merge it: ${prUrl}`,
  }),
};
