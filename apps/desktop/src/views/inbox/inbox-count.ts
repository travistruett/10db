import { useInboxCount } from '../../daemon/inbox-queries';
import { useSlackStatus } from '../../daemon/people';
import { useSystemCheck } from '../../daemon/queries';
import { systemCards } from './system-cards';

/**
 * What the sidebar and the menu bar count: the Inbox's Open rows, as the daemon counts them, and 10db's own
 * cards above them. It reads 0 while the count loads, so the badge waits rather than show a wrong number.
 */
export function useOpenInboxCount(): number {
  const slack = useSlackStatus();
  const rows = useInboxCount('open') ?? 0;
  return rows + systemCards(useSystemCheck().data, slack.data).length;
}
