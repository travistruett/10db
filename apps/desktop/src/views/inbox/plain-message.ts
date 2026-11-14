/**
 * The Slack message as plain text for the builder to paste to someone who is not in Slack: no `mrkdwn`
 * markers or escapes, and first person, since the builder sends it themselves ("My 10db build of
 * Renewals has a question for you."), never "You's".
 */
export function plainMessage(slackText: string): string {
  return slackText
    .replace(/^[^\n]*?'s 10db build of /, 'My 10db build of ')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,])/gm, '$1$2')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}
