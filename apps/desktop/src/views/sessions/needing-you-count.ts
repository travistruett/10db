/**
 * How many open sessions wait on the builder. It reads the Inbox once a tab's card is mirrored there; until
 * then no session raises a ring, so it is 0 and the sidebar shows no badge.
 */
export function useSessionsNeedingYouCount(): number {
  return 0;
}
