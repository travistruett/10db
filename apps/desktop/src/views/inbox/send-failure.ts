/** Why Slack turned a send down, in plain words, for the codes a builder meets. */
const REASONS: Readonly<Record<string, (who: string) => string>> = {
  channel_not_found: (who) => `${who} may have left the workspace.`,
  user_not_found: (who) => `${who} may have left the workspace.`,
  user_disabled: (who) => `${who}'s Slack account is deactivated.`,
  not_in_channel: () => 'The 10db app is no longer in that conversation.',
  is_archived: () => 'That conversation is archived.',
  ratelimited: () => 'Slack asked 10db to slow down; try again in a minute.',
  invalid_auth: () =>
    "10db's Slack token no longer works. Reconnect it in Settings › Integrations.",
  token_revoked: () =>
    "10db's Slack token no longer works. Reconnect it in Settings › Integrations.",
  account_inactive: () =>
    "10db's Slack token no longer works. Reconnect it in Settings › Integrations.",
  no_token: () => 'Slack is not connected. Connect it in Settings › Integrations.',
  unreachable: () => 'Slack could not be reached.',
  timeout: () => 'Slack took too long to answer.',
};

/**
 * The words for a failed send. The daemon stores Slack's bare code; a stored sentence is shown as it is.
 * `who` names the people the message was for.
 */
export function sendFailureWords(error: string | null, who: string): string {
  if (error === null || error === '') return 'Slack did not take the message.';
  if (!/^[a-z0-9_]+$/.test(error)) return error;
  const reason = REASONS[error];
  return `Slack refused: ${error}.${reason ? ` ${reason(who)}` : ''}`;
}
