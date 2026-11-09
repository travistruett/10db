import { useInbox, useSystemCheck } from '../../daemon/queries';
import { inboxRowCount } from './inbox-rows';
import { systemCards } from './system-cards';

/** What the sidebar and the menu bar count: the Inbox's rows and 10db's own cards above them. */
export function useOpenInboxCount(): number {
  return inboxRowCount(useInbox().data ?? []) + systemCards(useSystemCheck().data).length;
}
