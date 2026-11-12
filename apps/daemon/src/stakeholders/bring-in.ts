import { moveSend, sendSummary, type OpenSendRow } from '@10db/db';
import { ConflictError } from '@10db/contracts';
import type { StateStore } from '../events';
import type { Logger } from '../log';
import { SlackError, type SlackClient, type SlackMessage } from '../slack';
import { findLine, postLine } from './bot-lines';
import { mentionsToAdd, newMessages } from './conversation';
import { broughtInLine, couldntAddLine, fullLine, movedLine } from './lines';

/** Slack's limit for a group DM, besides the bot. */
const GROUP_MAX = 8;
const TRANSPORT = /^(?:unreachable|timeout|ratelimited|bad_reply|http_5\d\d)$/;

export interface BringInDeps {
  readonly client: SlackClient;
  readonly state: StateStore;
  readonly log: Logger;
  /** Mentions already answered with a refusal or a full line, by send and message, so no tick tries them again. */
  readonly handled: Set<string>;
  /** The closing line a card settled during a move is owed in the new conversation, or null. */
  readonly closingFor: (cardId: string) => string | null;
}

/**
 * A participant mentions someone who is not in the conversation: 10db opens a group DM with everyone, posts
 * the sent question there under a line saying who brought them in, tells the old thread, and moves the send.
 * A refused open posts that 10db could not add them, and changes nothing else. None of it is reviewed or
 * counted toward a limit. Every post carries the send's metadata, so a crash between the repost and the move
 * is found in the group DM's history and not posted twice. Answers whether the send moved.
 */
export async function bringIn(
  deps: BringInDeps,
  input: {
    readonly open: OpenSendRow;
    /** The window of messages this send reads, bot lines included. */
    readonly messages: readonly SlackMessage[];
    /** Everything in the current thread, for finding lines already posted. */
    readonly thread: readonly SlackMessage[];
    readonly bot: string;
  },
): Promise<boolean> {
  const { client, state, log } = deps;
  const { open, bot } = input;
  const participants = open.people.map((p) => p.userId);
  const counted = newMessages({
    messages: input.messages,
    participants,
    botUserId: bot,
    afterTs: open.messageTs,
  });
  // Mentions an earlier tick answered with a refusal or a full line are passed over; a later one is still tried.
  const keyOf = (m: { ts: string }): string => `${open.id}/${m.ts}`;
  const fresh = counted.filter(
    (m) => !deps.handled.has(keyOf(m)) && mentionsToAdd([toSlack(m)], participants, bot).length > 0,
  );
  const mention = fresh[0];
  if (!mention) return false;
  const markHandled = (): void => {
    for (const m of fresh) deps.handled.add(keyOf(m));
  };
  const newIds = mentionsToAdd(fresh.map(toSlack), participants, bot);
  const names = new Map<string, string>();
  for (const id of newIds) names.set(id, await client.userInfo(id).catch(() => id));
  const newNames = newIds.map((id) => names.get(id) ?? id);
  const broughtBy = open.people.find((p) => p.userId === mention.userId)?.name ?? 'Someone';
  const inCurrent = { channel: open.channelId, threadTs: open.threadTs, sendId: open.id };

  if (participants.length + newIds.length > GROUP_MAX) {
    if (!findLine(input.thread, open.id, 'full', { key: mention.ts }))
      await postLine(client, { ...inCurrent, text: fullLine(), line: 'full', key: mention.ts });
    markHandled();
    return false;
  }

  let channel: string;
  try {
    channel = await client.openGroup([...participants, ...newIds]);
  } catch (error) {
    if (!(error instanceof SlackError) || TRANSPORT.test(error.code) || error.code === 'no_token')
      throw error;
    for (const id of newIds) {
      if (!findLine(input.thread, open.id, 'couldnt_add', { key: id }))
        await postLine(client, {
          ...inCurrent,
          text: couldntAddLine(names.get(id) ?? id),
          line: 'couldnt_add',
          key: id,
        });
    }
    markHandled();
    return false;
  }

  const text = `${broughtInLine(broughtBy, newNames)}\n\n${sendSummary(state.db, open.id).text}`;
  const already = findLine(await client.history(channel, mention.ts), open.id, 'moved');
  const ts =
    already?.ts ?? (await postLine(client, { channel, text, sendId: open.id, line: 'moved' }));
  if (!findLine(input.thread, open.id, 'moved_notice', { key: ts }))
    await postLine(client, {
      ...inCurrent,
      text: movedLine(newNames),
      line: 'moved_notice',
      key: ts,
    });
  const permalink = await client.permalink(channel, ts).catch(() => null);
  try {
    state.write((ctx) => {
      moveSend(ctx, open.id, {
        channelId: channel,
        threadTs: ts,
        messageTs: ts,
        permalink,
        added: newIds.map((id) => ({
          userId: id,
          personId: null,
          name: names.get(id) ?? id,
          recipient: false,
        })),
      });
    });
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error;
    // The card was answered, taken back or cancelled meanwhile: the new conversation is told too.
    const closing = deps.closingFor(open.inboxItemId);
    if (closing !== null)
      await postLine(client, {
        channel,
        threadTs: ts,
        text: closing,
        sendId: open.id,
        line: 'closing',
      });
    log.info({ sendId: open.id }, 'a send closed while it was being moved');
    return false;
  }
  return true;
}

function toSlack(m: { ts: string; userId: string; text: string }): SlackMessage {
  return {
    ts: m.ts,
    threadTs: null,
    user: m.userId,
    botId: null,
    subtype: null,
    text: m.text,
    edited: false,
    reactions: [],
    metadata: null,
  };
}
