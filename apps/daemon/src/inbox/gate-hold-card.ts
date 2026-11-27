import { BuilderOwns, type ProjectId, Urgency } from '@10db/contracts';
import { findOpenByFoldKey, getProject } from '@10db/db';
import type { StateStore } from '../events';
import type { InboxService } from './service';
import { CardTier, decidedByBuilder } from './card-tier';

const RESOLVED = 'The gate got past its environment check';

function foldKey(projectId: ProjectId): string {
  return `gate-hold:${projectId}`;
}

/**
 * The one card for a project whose gates are held because its environment isn't ready (a dev stack out
 * of step with the checkout): what the gate asked for, and that 10db retries by itself. A status card
 * that closes when a held gate gets through; every held gate of the project shares it.
 */
export function raiseGateHoldCard(
  deps: { readonly state: StateStore; readonly inbox: InboxService },
  input: { readonly projectId: ProjectId; readonly reason: string },
): void {
  const name = getProject(deps.state.db, input.projectId).name;
  deps.inbox.flag({
    projectId: input.projectId,
    workstreamId: null,
    tier: CardTier.Status,
    urgency: Urgency.Normal,
    closesWhen: {
      by: 'withdrawn',
      when: 'a held gate gets past its environment check (gate-hold)',
    },
    decision: decidedByBuilder(BuilderOwns.YourHands),
    title: `${name}'s dev stack isn't in sync: its gates are waiting`,
    body: [
      `The gate printed this line (quoted as text): "${input.reason.replace(/"/g, "'")}"`,
      'Tasks whose gate hit this wait instead of failing. 10db runs the gate again every minute and goes on once it passes; this card closes itself then.',
    ].join('\n'),
    foldKey: foldKey(input.projectId),
  });
}

/** Closes the project's gate-hold card, if one is open. */
export function clearGateHoldCard(
  deps: { readonly state: StateStore; readonly inbox: InboxService },
  projectId: ProjectId,
): void {
  const card = findOpenByFoldKey(deps.state.db, projectId, foldKey(projectId));
  if (card !== undefined) deps.inbox.resolve(card.id, RESOLVED);
}
