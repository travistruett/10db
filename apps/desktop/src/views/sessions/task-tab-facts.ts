import {
  PassState,
  WorkstreamState,
  type InboxItemDto,
  type TaskId,
  type TaskSessionDto,
} from '@10db/contracts';
import { useQuery } from '@tanstack/react-query';
import { livePassesOptions } from '../../daemon/pass-queries';
import { useWorkstreams } from '../../daemon/queries';
import { useDaemon } from '../../daemon/provider';
import { useNow } from '../../shell/relative';
import { pageStatus } from '../workbench/page-status';
import { medianTurnMinutes } from '../workbench/timing';
import type { TaskTabFacts } from './task-tab-state';

/** How often a page's status is read again against the clock. */
const CLOCK_TICK_MS = 30_000;

/**
 * What each open task tab's mark is read from: the task's place on the Board, whether a copy's run
 * failed, and, for a pass of one, its page's status in the Workbench's own words.
 */
export function useTaskTabFacts(
  sessions: ReadonlyMap<TaskId, TaskSessionDto>,
  inbox: readonly InboxItemDto[],
): ReadonlyMap<TaskId, TaskTabFacts> {
  const { client } = useDaemon();
  const workstreams = useWorkstreams({ active: false }).data;
  const live = useQuery(livePassesOptions(client)).data;
  const now = useNow(CLOCK_TICK_MS);
  const facts = new Map<TaskId, TaskTabFacts>();
  for (const [taskId, session] of sessions) {
    const run = workstreams?.find((w) => w.id === session.workstreamId);
    const view =
      session.passId === null ? undefined : live?.find((v) => v.pass.id === session.passId);
    const page = view?.pages[0];
    facts.set(taskId, {
      board: session.board,
      failed: run?.state === WorkstreamState.Failed,
      page:
        view === undefined || page === undefined
          ? null
          : pageStatus(page, inbox, { now, medianTurnMinutes: medianTurnMinutes(view.turns) }, view)
              .status,
      passClosed: view?.pass.state === PassState.Closed,
    });
  }
  return facts;
}
