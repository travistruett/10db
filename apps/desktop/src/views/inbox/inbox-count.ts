import { useSlackConnection } from '../../daemon/people';
import { useInbox, useSystemCheck } from '../../daemon/queries';
import { openCount, splitInbox } from './inbox-rows';
import { systemCards } from './system-cards';

/** What the sidebar and the menu bar count: the Inbox's Open rows and 10db's own cards above them. */
export function useOpenInboxCount(): number {
  const connection = useSlackConnection();
  const { open } = splitInbox(useInbox().data ?? [], connection.data?.state);
  return openCount(open) + systemCards(useSystemCheck().data, connection.data).length;
}
