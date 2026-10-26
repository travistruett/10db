import type { ProjectDto, ProjectId } from '@10db/contracts';
import { getAccountRow, getProject, listMoveBacks, setMoveBack } from '@10db/db';
import { timerAt, type Clock, type Timer } from '../clock';
import type { StateStore } from '../events';
import type { InboxService } from '../inbox';
import { moveBackCard } from './cards';
import { usageLimitEnd, type AccountPauses } from './pauses';

export interface MoveBack {
  /**
   * Arms the reminder of a project that left an account for its usage limit: at its `moveBackAt`, or
   * after the default pause when nobody reported when the limit resets.
   */
  arm(projectId: ProjectId): void;
  /** Re-arms every reminder after a restart; one that came due meanwhile raises its card now. */
  restore(): void;
  stop(): void;
}

/** Asks, once the limit a project left for has reset, whether to move it back (accounts spec §6). */
export function createMoveBack(opts: {
  readonly state: StateStore;
  readonly clock: Clock;
  readonly inbox: InboxService;
  readonly pauses: Pick<AccountPauses, 'pausedFor'>;
  /** How long a usage limit with no reported reset lasts: the runtime's default pause. */
  readonly defaultPauseMs: number;
}): MoveBack {
  const db = opts.state.db;
  const timers = new Map<ProjectId, Timer>();

  const whenToAsk = (project: ProjectDto): Date =>
    project.moveBackAt === null
      ? new Date(opts.clock.now().getTime() + opts.defaultPauseMs)
      : new Date(project.moveBackAt);

  function schedule(projectId: ProjectId, at: Date): void {
    timers.get(projectId)?.cancel();
    if (at <= opts.clock.now()) {
      timers.delete(projectId);
      due(projectId);
      return;
    }
    timers.set(
      projectId,
      timerAt(opts.clock, at, () => {
        timers.delete(projectId);
        due(projectId);
      }),
    );
  }

  function due(projectId: ProjectId): void {
    const project = getProject(db, projectId);
    if (project.movedFromAccountId === null) return;
    const from = getAccountRow(db, project.movedFromAccountId);
    if (from.archived || from.id === project.accountId) {
      opts.state.write((ctx) => setMoveBack(ctx, projectId, null));
      return;
    }
    const stillLimited = usageLimitEnd(opts.pauses.pausedFor(from.id));
    if (stillLimited !== null && stillLimited > opts.clock.now()) {
      // The limit was met again after the move: ask when it really ends.
      opts.state.write((ctx) =>
        setMoveBack(ctx, projectId, { accountId: from.id, at: stillLimited.toISOString() }),
      );
      schedule(projectId, stillLimited);
      return;
    }
    const card = moveBackCard(project, from, getAccountRow(db, project.accountId));
    opts.inbox.flag({
      projectId,
      workstreamId: null,
      title: card.title,
      body: card.body,
      detail: card.detail,
      foldKey: card.foldKey,
      ...(card.options ? { options: card.options } : {}),
    });
  }

  return {
    arm(projectId) {
      const project = getProject(db, projectId);
      if (project.movedFromAccountId !== null) schedule(projectId, whenToAsk(project));
    },
    restore() {
      for (const project of listMoveBacks(db)) schedule(project.id, whenToAsk(project));
    },
    stop() {
      for (const timer of timers.values()) timer.cancel();
      timers.clear();
    },
  };
}
