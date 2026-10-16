// Builds the environment for a spawned claude from an allowlist, so a Bedrock- or API-key-billed parent session
// can never switch the child's billing. 10db's env builder (M1b) follows the same rule.
const ALLOWED = ['HOME', 'PATH', 'USER', 'SHELL', 'LANG', 'TERM', 'TMPDIR'] as const;
const FORBIDDEN = /^(AWS_|ANTHROPIC_|CLAUDE_CODE_|CLAUDE_AGENT_|CLAUDECODE$)/;
const CLIENT_APP_KEY = 'CLAUDE_AGENT_SDK_CLIENT_APP';

export function buildChildEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ALLOWED) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  env[CLIENT_APP_KEY] = '10db-spikes/0.0.0';
  assertCleanEnv(env);
  return env;
}

export function assertCleanEnv(env: Record<string, string>): void {
  const leaked = Object.keys(env).filter((key) => key !== CLIENT_APP_KEY && FORBIDDEN.test(key));
  if (leaked.length > 0) throw new Error(`child env leaks billing/provider vars: ${leaked.join(', ')}`);
}
