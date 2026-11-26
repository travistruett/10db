import { Provider } from '@10db/contracts';
import { ReachEvidence } from './reporter-reach';

const HELD = 'Its Linear updates are held and go out once it is.';

/**
 * Pure: which account needs a Linear sign-in and how to give it one, by the harness that runs it. It is the
 * reason a held update carries, and so the line the project's Inbox card leads with.
 */
export function signInNeeded(label: string, harness: Provider | null): string {
  if (harness === null)
    return `${label} isn't signed in to Linear. Connect Linear under Settings › Integrations. ${HELD}`;
  switch (harness) {
    case Provider.Codex:
      return `${label} isn't signed in to Linear. Connect Linear under Settings › Integrations signs it in in your browser. ${HELD}`;
    case Provider.Claude:
      return `${label} isn't signed in to Linear. Connect Linear under Settings › Integrations, then finish the sign-in with /mcp in Claude Code (or connect Linear on claude.ai). ${HELD}`;
  }
}

/**
 * Pure: why a run that ended without calling Linear spent a try instead of being held: the account's Linear works,
 * so a sign-in would not change it.
 */
export function noLinearCall(label: string, evidence: ReachEvidence): string {
  const works = ((): string => {
    switch (evidence) {
      case ReachEvidence.Answered:
        return `${label}'s Linear answered earlier in this conversation`;
      case ReachEvidence.SignedIn:
        return `${label}'s Linear sign-in check says it is signed in`;
    }
  })();
  return `The session ended without calling Linear, though ${works}, so this isn't a sign-in; it counts as a failed try and is tried again.`;
}
