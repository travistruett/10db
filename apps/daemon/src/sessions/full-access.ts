import { AccountKind } from '@10db/contracts';
import type { AgentSessionSpec, FullAccessSettings } from './types';

/** Whether a session is a chat the builder turned Full access on for; a lane's spec never is. */
export function isFullAccess(spec: AgentSessionSpec): boolean {
  return 'fullAccess' in spec;
}

/**
 * What a Full access chat's Claude session runs with, from the account it is on. A key in the session's env
 * (a Bedrock key) keeps `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, which Claude Code answers by running in
 * `default` mode, so the key never reaches the agent's commands and each ask is a card. An API key is read
 * through the Keychain helper instead, so nothing is in the env and auto mode runs where the model allows.
 */
export function fullAccessSettings(input: {
  readonly kind: AccountKind;
  readonly autoModeRuns: boolean;
  readonly apiKeyHelper: string | null;
  readonly defaultConfigDir: boolean;
  /** A key sits in the session's env: a Bedrock key, or an API key with no helper to read it by. */
  readonly keyInEnv: boolean;
}): FullAccessSettings {
  const scrub = input.keyInEnv;
  return {
    permissionMode: input.autoModeRuns && !scrub ? 'auto' : 'default',
    apiKeyHelper: input.kind === AccountKind.AnthropicApiKey ? input.apiKeyHelper : null,
    scrub,
    ownSetup: input.defaultConfigDir,
  };
}

/** The session's env: an API key read by the helper is never in it. */
export function fullAccessEnv(
  env: Readonly<Record<string, string>>,
  full: Pick<FullAccessSettings, 'apiKeyHelper'>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name]) => full.apiKeyHelper === null || name !== 'ANTHROPIC_API_KEY',
    ),
  );
}
