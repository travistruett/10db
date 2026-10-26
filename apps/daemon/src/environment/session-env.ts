import { withoutGitRepoEnv } from '../git';

/** Variables that silently change who is billed. A session gets one back only through its account's launch. */
export const BILLING_SWITCH_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_MODEL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  // A config directory or an OAuth token picks the subscription, so only an account may set one.
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const;
/**
 * Whole families of provider switches, so a provider added in a later Claude Code release is stripped too.
 * `CLAUDE_CODE_USE_*` also catches non-billing toggles; none of them matter to a managed session on macOS.
 */
const BILLING_SWITCH_PREFIXES = [
  'ANTHROPIC_DEFAULT_',
  'CLAUDE_CODE_USE_',
  'ANTHROPIC_VERTEX_',
  'ANTHROPIC_FOUNDRY_',
] as const;
/** Set inside a Claude Code session; a managed session started from one must not inherit them. */
export const NESTED_SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_PROJECT_DIR',
] as const;

const OWN_PREFIX = 'TENDB_';
const SWITCHES: readonly string[] = BILLING_SWITCH_VARS;
const NESTED: readonly string[] = NESTED_SESSION_VARS;

function isBillingSwitch(name: string): boolean {
  return (
    SWITCHES.includes(name) || BILLING_SWITCH_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/** The login environment without any billing switch, nested-session marker, 10db variable or git repository variable. */
export function stripBillingSwitches(
  base: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(withoutGitRepoEnv(base)).filter(
      ([name]) => !name.startsWith(OWN_PREFIX) && !NESTED.includes(name) && !isBillingSwitch(name),
    ),
  );
}
