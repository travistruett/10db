import { PermissionChoice, type InboxOption, type LimitName } from '@10db/contracts';
import type { LimitAt } from '../trust';

/** Where a limit card's detail names the limit 10db's judge stopped the call at. */
export const LIMIT_DETAIL = 'limit';
/** Where a limit card's detail holds the call as a grant quotes it (`grantCallSummary`). */
export const GRANT_CALL_DETAIL = 'grantCall';
/** Set on a limit card whose call is too long to keep as a grant: Always in this project needs a note. */
export const NOTE_NEEDED_DETAIL = 'noteNeeded';

const ALWAYS =
  'Allow calls like this in this project from now on. Your note, if you write one, says what to allow, such as "deploys to staging with vercel"; without one, this exact call is allowed.';
const ALWAYS_NEEDS_NOTE =
  "Allow calls like this in this project from now on. Say in your note what to allow: this call can't be kept as it is.";

/** The trust line's three answers to a limit or an escalation: once, always in this project, or deny. */
export function limitOptions(noteNeeded: boolean): InboxOption[] {
  return [
    { label: PermissionChoice.AllowOnce, description: 'Allow this call once' },
    {
      label: PermissionChoice.AlwaysInProject,
      description: noteNeeded ? ALWAYS_NEEDS_NOTE : ALWAYS,
    },
    { label: PermissionChoice.Deny, description: 'Deny; your note is passed to the agent' },
  ];
}

export const LIMIT_OPTIONS: readonly InboxOption[] = limitOptions(false);

const TITLES: Readonly<Record<LimitName, string>> = {
  destroys_data: "Allow this? It may destroy data this session didn't create",
  sends_data_out: 'Allow this? It may send data out',
  reads_secrets: 'Allow this? It may read secrets',
  writes_live: 'Allow this? It may write to a live system',
};

/** A limit card's title: the limit the call may cross, or that 10db's judge wasn't sure. */
export function limitCardTitle(at: LimitAt): string {
  return at.limit === null ? "Allow this? 10db's judge wasn't sure it is safe" : TITLES[at.limit];
}
