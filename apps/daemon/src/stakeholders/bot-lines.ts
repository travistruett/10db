import { compareTs, type SlackClient, type SlackMessage } from '../slack';
import { blocksOf } from './slack-text';

/** The metadata event type every message 10db posts about a send carries. */
export const SEND_EVENT = 'tendb_send';

/**
 * The line 10db already posted for a send, found by its metadata, newer than `after` when given. A crash
 * between a post and its write leaves the line in Slack; the next tick finds it here instead of posting again.
 */
export function findLine(
  messages: readonly SlackMessage[],
  sendId: string,
  line: string,
  opts: { readonly after?: string; readonly key?: string } = {},
): SlackMessage | undefined {
  return messages.find(
    (m) =>
      m.metadata?.eventType === SEND_EVENT &&
      m.metadata.eventPayload['sendId'] === sendId &&
      m.metadata.eventPayload['line'] === line &&
      (opts.key === undefined || m.metadata.eventPayload['key'] === opts.key) &&
      (opts.after === undefined || compareTs(m.ts, opts.after) > 0),
  );
}

/** Posts a line about a send with its metadata, in a thread or at the top of a conversation; answers its `ts`. */
export async function postLine(
  client: SlackClient,
  input: {
    readonly channel: string;
    readonly threadTs?: string;
    readonly text: string;
    readonly sendId: string;
    readonly line: string;
    readonly key?: string;
  },
): Promise<string> {
  const posted = await client.post({
    channel: input.channel,
    text: input.text,
    blocks: blocksOf(input.text),
    ...(input.threadTs === undefined ? {} : { threadTs: input.threadTs }),
    metadata: {
      eventType: SEND_EVENT,
      eventPayload: {
        sendId: input.sendId,
        line: input.line,
        ...(input.key === undefined ? {} : { key: input.key }),
      },
    },
  });
  return posted.ts;
}
