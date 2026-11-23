/** Where the Slack Web API answers. */
export const SLACK_API = 'https://slack.com/api';

/**
 * A fetch that sends Slack Web API calls to `base` instead and everything else on unchanged: the dev window's
 * fake Slack (`TENDB_SLACK_API`) answers in place of the real one.
 */
export function slackApiAt(base: string, inner: typeof fetch): typeof fetch {
  const target = base.replace(/\/+$/, '');
  return (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(`${SLACK_API}/`)) return inner(input, init);
    return inner(`${target}${url.slice(SLACK_API.length)}`, init);
  };
}
