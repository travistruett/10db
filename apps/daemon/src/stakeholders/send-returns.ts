import {
  RoutedBy,
  SendFailure,
  SendState,
  type InboxItemId,
  type StakeholderSendId,
} from '@10db/contracts';
import {
  BUILDER_HANDLE,
  clearTeamDmChannels,
  failSend,
  liveSendsWhere,
  setInboxRecipients,
  type WriteContext,
} from '@10db/db';
import type { SlackIdentity } from '../slack';
import { readSlackWorkspaces, writeSlackWorkspaces } from './slack-workspaces';

/** Fails each send with `code` and gives its card back to the builder; in the caller's write. */
export function failSendsToBuilder(
  ctx: WriteContext,
  sends: readonly { readonly id: StakeholderSendId; readonly inboxItemId: InboxItemId }[],
  code: string,
): void {
  for (const send of sends) {
    failSend(ctx, send.id, code);
    setInboxRecipients(ctx, send.inboxItemId, {
      assignees: [BUILDER_HANDLE],
      routedBy: RoutedBy.Builder,
      suggestion: null,
    });
  }
}

/** A workspace's bot is new: its DM channels and cursors go, and its sending and sent sends fail `bot_changed`. */
export function recoverFromBotChange(ctx: WriteContext, teamId: string): StakeholderSendId[] {
  clearTeamDmChannels(ctx, teamId);
  const live = liveSendsWhere(ctx.tx, { teamId }).filter(
    (s) => s.state === SendState.Sending || s.state === SendState.Sent,
  );
  failSendsToBuilder(ctx, live, SendFailure.BotChanged);
  return live.map((s) => s.id);
}

/**
 * Records the bot a check found. None on record: record it with `botSince` now and forget the team's DM channels.
 * The same bot: nothing. A different bot: from a saved token, recoverFromBotChange and record it; from a watch's
 * check, nothing (the check read a token that has since been replaced).
 */
export function recordBot(
  ctx: WriteContext,
  identity: SlackIdentity,
  source: 'token' | 'check',
): void {
  const all = readSlackWorkspaces(ctx.tx);
  const entry = all.find((w) => w.teamId === identity.teamId);
  if (entry === undefined) return;
  if (entry.botUserId === identity.botUserId) return;
  if (entry.botUserId === undefined) {
    clearTeamDmChannels(ctx, identity.teamId);
  } else if (source === 'check') {
    return;
  } else {
    recoverFromBotChange(ctx, identity.teamId);
  }
  writeSlackWorkspaces(
    ctx,
    all.map((w) =>
      w.teamId === identity.teamId
        ? {
            ...w,
            botUserId: identity.botUserId,
            botName: identity.botName,
            botSince: ctx.now,
          }
        : w,
    ),
  );
}
