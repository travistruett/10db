import { passHoldsTasks, type ProjectId } from '@10db/contracts';
import { useLivePass } from '../../daemon/pass-queries';
import { useInbox } from '../../daemon/queries';
import { useNow } from '../../shell/relative';
import { waitingCount } from './queue-order';
import { queueRows } from './queue-rows';

/**
 * What the sidebar counts on the Workbench (Workbench spec §4.1): the pages of the project's pass that
 * wait on the builder, by the queue's own ranks; 0 with no pass holding pages, as Factory's line.
 */
export function useWorkbenchWaitingCount(projectId: ProjectId): number {
  const live = useLivePass(projectId).data;
  const inbox = useInbox().data ?? [];
  const now = useNow();
  return live == null || !passHoldsTasks(live.pass.state)
    ? 0
    : waitingCount(queueRows(live, inbox, now));
}
