import type { ProjectDto, ProjectId } from '@10db/contracts';
import type { Clock, Timer } from '../clock';
import type { Logger } from '../log';

// When a project's sign-in is checked by itself: once the daemon listens, whenever its app address or
// dev login command changes, and once a day for each project that has both.

/** How often the daily check runs. */
export const SIGN_IN_CHECK_EVERY_MS = 24 * 60 * 60_000;

/** A project a sign-in check is worth running for: live, with an app address and a dev login. */
export function checkable(
  project: Pick<ProjectDto, 'appUrl' | 'devLoginCommand' | 'archivedAt'>,
): boolean {
  return project.archivedAt === null && project.appUrl !== null && project.devLoginCommand !== null;
}

export interface SignInScheduleDeps {
  readonly clock: Clock;
  readonly logger: Logger;
  /** Settles once the daemon's API listens, as no check runs before then. */
  readonly ready: Promise<unknown>;
  readonly projects: () => readonly Pick<
    ProjectDto,
    'id' | 'appUrl' | 'devLoginCommand' | 'archivedAt'
  >[];
  /** Runs the check; `fresh` stops one under way, whose project changed since it began. */
  readonly check: (projectId: ProjectId, fresh: boolean) => Promise<unknown>;
  /** Told a project has nothing to check any more (its app address or dev login command was cleared). */
  readonly nothingToCheck: (projectId: ProjectId) => void;
  /** Reads a project as it stands now. */
  readonly project: (
    projectId: ProjectId,
  ) => Pick<ProjectDto, 'id' | 'appUrl' | 'devLoginCommand' | 'archivedAt'>;
}

export interface SignInSchedule {
  /** A project's app address or dev login command changed: checks it now, or stands down if none is left. */
  changed(projectId: ProjectId): void;
  stop(): void;
}

/** Starts the checks at daemon start and then every day, until stopped. */
export function startSignInSchedule(deps: SignInScheduleDeps): SignInSchedule {
  let stopped = false;
  let timer: Timer | null = null;

  const checkOne = async (projectId: ProjectId, fresh: boolean): Promise<void> => {
    try {
      await deps.check(projectId, fresh);
    } catch (error) {
      if (!stopped)
        deps.logger.warn(
          { projectId, err: error instanceof Error ? error.message : String(error) },
          'could not check the picture sign-in',
        );
    }
  };

  const runAll = async (): Promise<void> => {
    for (const project of deps.projects()) {
      if (stopped) return;
      if (checkable(project)) await checkOne(project.id, false);
    }
  };

  const daily = (): void => {
    timer = deps.clock.setTimeout(() => {
      void runAll().finally(() => {
        if (!stopped) daily();
      });
    }, SIGN_IN_CHECK_EVERY_MS);
  };

  void deps.ready.then(() => {
    if (stopped) return;
    void runAll().finally(() => {
      if (!stopped) daily();
    });
  });

  return {
    changed(projectId) {
      if (stopped) return;
      if (checkable(deps.project(projectId))) void checkOne(projectId, true);
      else deps.nothingToCheck(projectId);
    },
    stop() {
      stopped = true;
      timer?.cancel();
    },
  };
}
