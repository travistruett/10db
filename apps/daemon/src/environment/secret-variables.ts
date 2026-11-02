/**
 * Variables that hold an account's credential. The lane sandbox must deny each by name so no
 * agent command can read them; the sandbox tests assert that against this list.
 */
export const SECRET_VARIABLES: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
];
