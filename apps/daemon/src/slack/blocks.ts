/**
 * The one Block Kit shape 10db posts: a section of `mrkdwn`. `verbatim` is always true, so Slack neither
 * links names nor turns text into mentions on its own.
 */
export interface SlackBlock {
  readonly type: 'section';
  readonly text: { readonly type: 'mrkdwn'; readonly text: string; readonly verbatim: true };
}

/** Data Slack stores with a message and returns on reads, such as the send a post belongs to. */
export interface SlackMetadata {
  readonly eventType: string;
  readonly eventPayload: Readonly<Record<string, string | number | boolean>>;
}
