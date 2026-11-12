// Decision 2026-11-11-10db-runs-the-preview-while-a-pass-is-open: 10db's own dev UI is code a pass's
// agents may be editing, so the token Open Page hands it reads what a page shows and nothing else.
// What writes or acts is done in the 10db app, over its own token.

/** GETs that write, run a command, or hand out a token: no dev UI reaches them. */
const NOT_READS: readonly string[] = [
  '/goals/:goalId/digest', // moves the goal's last-opened mark
  '/accounts/:accountId/identity', // runs a command against the account's login
  '/accounts/:accountId/signin', // a sign-in command for the builder's terminal
  '/system', // probes the machine and runs commands
  '/dev-ui/connection', // this token itself, for the app's Open Page
];

const PARAM = '[A-Za-z0-9_-]+';
const refused = NOT_READS.map((route) => new RegExp(`^${route.replace(/:[A-Za-z]+/g, PARAM)}$`));

/** Whether the dev UI's token may make this request: a GET that only reads. */
export function devUiMayRead(method: string, path: string): boolean {
  return method === 'GET' && !refused.some((pattern) => pattern.test(path));
}
