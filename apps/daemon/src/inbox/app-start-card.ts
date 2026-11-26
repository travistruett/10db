import { type ProjectId, Urgency } from '@10db/contracts';
import { findOpenByFoldKey } from '@10db/db';
import type { StateStore } from '../events';
import type { InboxService } from './service';
import { CardTier } from './card-tier';

const RESOLVED = "The project's app answers at its address";
const MAX_COMMAND_CHARS = 400;
const MAX_SAW_CHARS = 1200;

function foldKey(projectId: ProjectId): string {
  return `app-start:${projectId}`;
}

const flat = (text: string, max: number): string => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
};

/**
 * The one card for a project whose dev stack 10db tried to bring up for a picture or a sign-in and
 * could not: what it ran and what it saw. The picture or sign-in is skipped and 10db does not try
 * again by itself until the wait has passed. A status card that closes when the app answers again; a
 * later failure refreshes it, so the project never has more than one.
 */
export function raiseAppStartCard(
  deps: { readonly state: StateStore; readonly inbox: InboxService },
  input: {
    readonly projectId: ProjectId;
    readonly projectName: string;
    readonly appUrl: string;
    /** What 10db ran, as the builder wrote it; null when it ran nothing (Docker Desktop never came up). */
    readonly ran: string | null;
    /** What it saw: the exit, the deadline it passed, or the tail of the output. */
    readonly saw: string;
  },
): void {
  deps.inbox.flag({
    projectId: input.projectId,
    workstreamId: null,
    tier: CardTier.Status,
    urgency: Urgency.Normal,
    closesWhen: {
      by: 'withdrawn',
      when: 'the project app answers at its address (app-start)',
    },
    title: `${input.projectName}'s app did not start`,
    body: [
      `Nothing answered at ${input.appUrl}, so 10db tried to bring the app up for a picture or a sign-in. The picture or sign-in was skipped.`,
      input.ran === null
        ? 'It ran: nothing; Docker Desktop was needed first.'
        : `It ran (quoted as text): "${flat(input.ran, MAX_COMMAND_CHARS).replace(/"/g, "'")}"`,
      `It saw: ${flat(input.saw, MAX_SAW_CHARS)}`,
      "10db tries once, and again after a wait if a later picture needs the app; it never loops. Check the app's start command in Settings › App Preview.",
    ].join('\n'),
    foldKey: foldKey(input.projectId),
    refresh: true,
  });
}

/** Closes the project's app-start card, if one is open. */
export function clearAppStartCard(
  deps: { readonly state: StateStore; readonly inbox: InboxService },
  projectId: ProjectId,
): void {
  const card = findOpenByFoldKey(deps.state.db, projectId, foldKey(projectId));
  if (card !== undefined) deps.inbox.resolve(card.id, RESOLVED);
}
