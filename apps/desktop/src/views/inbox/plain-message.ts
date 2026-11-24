/**
 * The Slack message as plain text for the builder to paste to someone who is not in Slack: no `mrkdwn`
 * markers or escapes, and first person, since the builder sends it themselves ("I have a quick question
 * for you about Renewals.").
 */
export function plainMessage(slackText: string): string {
  return slackText
    .replace(/^[^\n]*? has a quick question for /, 'I have a quick question for ')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,])/gm, '$1$2')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}
