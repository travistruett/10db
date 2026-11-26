import { CARD_OPENS, type ProjectId, Urgency } from '@10db/contracts';
import { findOpenByFoldKey, getProject } from '@10db/db';
import type { StateStore } from '../events';
import type { InboxService } from './service';
import { CardTier } from './card-tier';

const RESOLVED = 'The dev login signed the picture browser in';

/** The fold key of a project's card for a failed picture sign-in; one per project. */
export function pictureSignInFoldKey(projectId: ProjectId): string {
  return `picture-sign-in:${projectId}`;
}

/** What a failed sign-in leaves on the card: the words, and what the command printed, masked. */
export interface PictureSignInFailure {
  readonly projectId: ProjectId;
  readonly problem: string;
  readonly exitCode: number | null;
  readonly output: string;
}

/**
 * The one card for a project whose picture sign-in failed: no picture of its pages is taken, and
 * none reaches Slack or Linear, until the dev login works. A status card that a check or a sign-in
 * that works closes, so a repeat of the failure only refreshes the card's words.
 */
export function raisePictureSignInCard(
  deps: { readonly state: StateStore; readonly inbox: InboxService },
  failure: PictureSignInFailure,
): void {
  const name = getProject(deps.state.db, failure.projectId).name;
  const printed = failure.output === '' ? [] : ['What it printed (masked):', failure.output];
  deps.inbox.flag({
    projectId: failure.projectId,
    workstreamId: null,
    tier: CardTier.Status,
    urgency: Urgency.Normal,
    closesWhen: {
      by: 'withdrawn',
      when: "the project's dev login signs the picture browser in (picture-sign-in)",
    },
    title: `${name}'s pictures can't sign in`,
    body: [
      failure.problem,
      'No picture of its pages is taken while this lasts, so none reaches Slack or Linear. The dev login command must work by itself every time: create its fictional user if it is missing, run only against the dev database, be safe to repeat, and print one sign-in address.',
      'Fix the command in Settings › App Preview. 10db checks it again when it changes, when the daemon starts and once a day, and this card closes itself when it signs in.',
      ...printed,
    ].join('\n'),
    detail: {
      [CARD_OPENS]: {
        to: 'settings',
        section: 'pages-and-pictures',
        label: 'Open App Preview',
      },
      ...(failure.exitCode === null ? {} : { exitCode: failure.exitCode }),
    },
    refresh: true,
    foldKey: pictureSignInFoldKey(failure.projectId),
  });
}

/** Closes the project's picture sign-in card, if one is open. */
export function clearPictureSignInCard(
  deps: { readonly state: StateStore; readonly inbox: InboxService },
  projectId: ProjectId,
): void {
  const card = findOpenByFoldKey(deps.state.db, projectId, pictureSignInFoldKey(projectId));
  if (card !== undefined) deps.inbox.resolve(card.id, RESOLVED);
}
