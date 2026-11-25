import { useInboxCount } from '../../daemon/inbox-queries';
import { useSlackStatus } from '../../daemon/people';
import { useSystemCheck } from '../../daemon/queries';
import { useRowsInOpenChats } from './open-chat-cards';
import { systemCards } from './system-cards';

/**
 * What the sidebar and the menu bar count: the Inbox's Open rows, as the daemon counts them, and 10db's own
 * cards above them, less the rows that hold only cards of a chat open in a tab, which that chat shows. It reads 0 while the count loads, so the badge waits rather than show a wrong number.
 */
export function useOpenInboxCount(): number {
  const slack = useSlackStatus();
  const rows = Math.max(0, (useInboxCount('open') ?? 0) - useRowsInOpenChats());
  return rows + systemCards(useSystemCheck().data, slack.data).length;
}
