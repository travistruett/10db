import {
  passHoldsTasks,
  type InboxItemDto,
  type PassViewDto,
  type ProjectId,
} from '@10db/contracts';
import { pageStatus } from '../workbench/page-status';
import { passTitle } from '../workbench/pass-title';
import { waitingCount } from '../workbench/queue-order';
import { medianTurnMinutes } from '../workbench/timing';

/** A Workbench pass that holds work, with how many of its pages wait on the builder. */
export interface LivePass {
  readonly key: string;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly waiting: number;
}

/** The passes that hold work in the shown projects, so Factory's window and the phone count the same. */
export function livePassesOf(
  passes: readonly PassViewDto[],
  inbox: readonly InboxItemDto[],
  now: number,
  inView: (projectId: ProjectId) => boolean,
): LivePass[] {
  return passes
    .filter((view) => passHoldsTasks(view.pass.state) && inView(view.pass.projectId))
    .map((view) => {
      const clock = { now, medianTurnMinutes: medianTurnMinutes(view.turns) };
      const waiting = waitingCount(
        view.pages.map((page) => ({
          status: pageStatus(page, inbox, clock, view).status,
          readyAt: page.turn?.readyAt ?? null,
        })),
      );
      return {
        key: view.pass.id,
        projectId: view.pass.projectId,
        title: passTitle(view.pages, view.pass.name),
        waiting,
      };
    });
}
