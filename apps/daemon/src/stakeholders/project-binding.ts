import {
  RoutedBy,
  SendFailure,
  SendState,
  type InboxItemId,
  type ProjectId,
} from '@10db/contracts';
import {
  dropDraft,
  getInboxItem,
  liveSendsWhere,
  sendForCard,
  setInboxRecipients,
  type WriteContext,
  getPerson,
} from '@10db/db';
import type { Logger } from '../log';
import { draftOnOpen } from './drafts';
import { failSendsToBuilder } from './send-returns';
import { dropSharingChannelOutside } from './slack-sharing';
import { projectSlack, setProjectSlack } from './slack-workspaces';

/**
 * Binds a project to a workspace or Off and takes back what it had elsewhere, in the caller's one write: sending
 * and sent sends in another team (any team, for Off) fail `workspace_changed`; drafts in another team are dropped
 * and drafted again for the same people when the new binding is a workspace. Returns the drafts' after-commit steps.
 * It makes no Slack call.
 */
export function rebindProjectSlack(
  ctx: WriteContext,
  projectId: ProjectId,
  teamId: string | null,
  opts: { readonly afterDraft: (id: InboxItemId) => void; readonly log: Logger },
): (() => void)[] {
  setProjectSlack(ctx, projectId, teamId);
  dropSharingChannelOutside(ctx, projectId, teamId);
  const now = projectSlack(ctx.tx, projectId).teamId;
  const live = liveSendsWhere(ctx.tx, { projectId });
  const elsewhere = (sendTeam: string | null): boolean => now === null || sendTeam !== now;
  failSendsToBuilder(
    ctx,
    live.filter(
      (s) => (s.state === SendState.Sending || s.state === SendState.Sent) && elsewhere(s.teamId),
    ),
    SendFailure.WorkspaceChanged,
  );
  // Off leaves drafts alone: each is held `slack_off` at its next `afterDraft`, or a 409 at Send.
  if (now === null) return [];
  const after: (() => void)[] = [];
  for (const draft of live) {
    if (draft.state !== SendState.Draft || !elsewhere(draft.teamId)) continue;
    const people = (sendForCard(ctx.tx, draft.inboxItemId)?.people ?? []).flatMap((p) =>
      p.recipient && p.personId !== null ? [getPerson(ctx.tx, p.personId)] : [],
    );
    dropDraft(ctx, draft.id);
    const routed = setInboxRecipients(ctx, draft.inboxItemId, {
      assignees: people.map((p) => p.handle),
      routedBy: RoutedBy.Builder,
      suggestion: null,
    });
    const done = draftOnOpen(ctx, getInboxItem(ctx.tx, routed.id), opts);
    if (done) after.push(done);
  }
  return after;
}
