/**
 * A Slack call that did not yield what 10db needs. `code` is Slack's own `error` word, or one of
 * `http_<status>`, `timeout`, `unreachable`, `bad_reply`, `no_token`. The message names the method and
 * the code and never anything from the request, so the token cannot reach a log line or a card.
 */
export class SlackError extends Error {
  override readonly name = 'SlackError';
  readonly method: string;
  readonly code: string;
  /** Set for `ratelimited`: how long Slack asked us to wait. */
  readonly retryAfterSeconds?: number;

  constructor(method: string, code: string, retryAfterSeconds?: number) {
    super(`Slack ${method} failed: ${code}`);
    this.method = method;
    this.code = code;
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}

const REFUSED_CODES: ReadonlySet<string> = new Set([
  'invalid_auth',
  'token_revoked',
  'account_inactive',
  'not_authed',
]);

/** Whether Slack turned the token itself down, as opposed to refusing one request. */
export function slackRefusedToken(error: unknown): boolean {
  return error instanceof SlackError && REFUSED_CODES.has(error.code);
}
