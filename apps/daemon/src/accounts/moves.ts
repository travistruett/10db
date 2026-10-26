import {
  AccountPauseReason,
  ACTIVE_STATES,
  type AccountDto,
  type AccountId,
  type InboxItemId,
  type ProjectDto,
  type ProjectId,
  type ProjectPatch,
} from '@10db/contracts';
import {
  findOpenByFoldKey,
  getProject,
  listAccounts,
  listProjects,
  listWorkstreams,
  patchProject,
  setMoveBack,
  type DbReader,
} from '@10db/db';
import type { StateStore } from '../events';
import type { InboxService } from '../inbox';
import { accountFoldKey, MOVE_BACK_CARD } from './cards';
import type { MoveBack } from './move-back';
import { usageLimitEnd, type AccountPauses } from './pauses';

export const MoveCause = { Builder: 'builder', UsageLimit: 'usage_limit' } as const;
export type MoveCause = (typeof MoveCause)[keyof typeof MoveCause];

/** Why a project moves: the builder chose to, or its account reached its usage limit. */
export type MoveWhy =
  | { readonly cause: typeof MoveCause.Builder }
  | { readonly cause: typeof MoveCause.UsageLimit; readonly resetsAt: Date | null };

export interface AccountMoves {
  /**
   * Moves the project, with `patch`'s other fields in the same write. Work in flight follows at each
   * lane's next session. A move off an account at its usage limit, or because of it, is remembered
   * for the move back. `answering` is the card whose answer this is, which the inbox closes itself.
   */
  move(
    projectId: ProjectId,
    to: AccountId,
    why: MoveWhy,
    opts?: { readonly patch?: ProjectPatch; readonly answering?: InboxItemId },
  ): ProjectDto;
  /** The builder keeps the project where it is: the move back is forgotten. */
  stay(projectId: ProjectId): void;
}

/** Projects on the account with work in flight: a workstream that is not done, failed or cancelled. */
export function projectsWithWork(db: DbReader, accountId: AccountId): ProjectDto[] {
  const busy = new Set(listWorkstreams(db, { states: [...ACTIVE_STATES] }).map((w) => w.projectId));
  return listProjects(db).filter((p) => p.accountId === accountId && busy.has(p.id));
}

/** The accounts a project could move to now: not archived, not its own, not paused. */
export function moveTargets(
  db: DbReader,
  project: ProjectDto,
  isPaused: (id: AccountId) => boolean,
): AccountDto[] {
  return listAccounts(db).filter((a) => a.id !== project.accountId && !isPaused(a.id));
}

export function createAccountMoves(opts: {
  readonly state: StateStore;
  readonly inbox: InboxService;
  readonly pauses: Pick<AccountPauses, 'pausedFor'>;
  readonly moveBack: Pick<MoveBack, 'arm'>;
  /** A project moved: the scheduler looks again, and re-queues work only the old account held. */
  onMoved(projectId: ProjectId): void;
}): AccountMoves {
  const db = opts.state.db;

  /** A move makes the project's cards that offered one moot. */
  function withdrawMoot(
    project: ProjectDto,
    from: AccountId,
    answering: InboxItemId | undefined,
  ): void {
    const keys = [
      accountFoldKey(from, AccountPauseReason.UsageLimit),
      ...(project.movedFromAccountId === null
        ? []
        : [accountFoldKey(project.movedFromAccountId, MOVE_BACK_CARD)]),
    ];
    for (const key of keys) {
      const open = findOpenByFoldKey(db, project.id, key);
      if (open && open.id !== answering) opts.inbox.withdraw(open.id);
    }
  }

  return {
    move(projectId, to, why, { patch = {}, answering } = {}) {
      const project = getProject(db, projectId);
      const from = project.accountId;
      if (to === from)
        return opts.state.write((ctx) => patchProject(ctx, projectId, { ...patch, accountId: to }));
      const paused = opts.pauses.pausedFor(from);
      const limitEnds = usageLimitEnd(paused);
      const forLimit = why.cause === MoveCause.UsageLimit || limitEnds !== null;
      // Null when nobody reported when the limit resets: the move back asks after its default pause.
      const backAt = limitEnds ?? (why.cause === MoveCause.UsageLimit ? why.resetsAt : null);
      const moved = opts.state.write((ctx) => {
        patchProject(ctx, projectId, { ...patch, accountId: to });
        // Leaving for a limit is temporary: remember where from, and when that limit resets.
        return forLimit
          ? setMoveBack(ctx, projectId, { accountId: from, at: backAt?.toISOString() ?? null })
          : getProject(ctx.tx, projectId);
      });
      withdrawMoot(project, from, answering);
      if (forLimit) opts.moveBack.arm(projectId);
      opts.onMoved(projectId);
      return moved;
    },
    stay(projectId) {
      opts.state.write((ctx) => setMoveBack(ctx, projectId, null));
    },
  };
}
