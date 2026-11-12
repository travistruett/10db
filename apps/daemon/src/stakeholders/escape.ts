/**
 * Makes text from a card or from Slack safe to place in a `mrkdwn` message: `&`, `<` and `>` can no longer
 * start a mention, a link or a channel ping, and backticks (which would open code spans) are dropped.
 */
export function escapeMrkdwn(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('`', '');
}
