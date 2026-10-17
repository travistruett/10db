import { join } from 'node:path';
import { z } from 'zod';
import { readRepoConfigFile, RepoConfigFileError } from './repo-config-file';

const SETTINGS_FILE = join('.claude', 'settings.json');
/**
 * Whole families of `env` names a repo may not set. Claude Code applies a project's `env` after 10db has built
 * the session environment, so these would change who is billed, which account or endpoint is used, or what
 * sits between claude and the API (a proxy or a TLS trust root), and no account check would show it. Matched
 * case-insensitively, so a family added in a later release is covered too.
 */
const REFUSED_ENV_PREFIXES = [
  'ANTHROPIC_',
  'CLAUDE_',
  'AWS_',
  'GOOGLE_',
  'CLOUD_ML_',
  'VERTEX_',
  'NODE_',
  'SSL_',
  'OTEL_',
] as const;
const REFUSED_ENV_SUFFIXES = ['_PROXY'] as const;
const REFUSED_ENV_NAMES = ['REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE'] as const;
/** Settings that run a repo-chosen command when claude starts, to fetch credentials or proxy authentication. */
const REFUSED_COMMAND_KEYS = [
  'apiKeyHelper',
  'proxyAuthHelper',
  'awsCredentialExport',
  'awsAuthRefresh',
  'gcpAuthRefresh',
  'otelHeadersHelper',
] as const;
/** Turns off every hook, including 10db's guard and its billing re-check after each tool call. */
const REFUSED_HOOK_KEYS = ['disableAllHooks'] as const;

function refusedEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    REFUSED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix)) ||
    REFUSED_ENV_SUFFIXES.some((suffix) => upper.endsWith(suffix)) ||
    REFUSED_ENV_NAMES.some((refused) => upper === refused)
  );
}

/** Only `env` matters here; every other key passes through. */
const ProjectSettings = z.looseObject({ env: z.record(z.string(), z.string()).optional() });

/**
 * Whether the repo's committed `.claude/settings.json` could change who is billed or where requests go.
 * Claude Code applies its `env` block to the session after 10db has stripped the same names from the login
 * environment, and no account check would show it. Returns why the session must not start, or null. A missing
 * file is fine; an unreadable or invalid one fails closed, as does anything but a regular file under the size
 * cap. Names are reported, never values.
 */
export function projectSettingsBillingProblem(cwd: string): string | null {
  let text: string | null;
  try {
    text = readRepoConfigFile(join(cwd, SETTINGS_FILE));
  } catch (error) {
    if (!(error instanceof RepoConfigFileError)) throw error;
    return `${SETTINGS_FILE} could not be read (${error.message})`;
  }
  if (text === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return `${SETTINGS_FILE} is not valid JSON`;
  }
  const parsed = ProjectSettings.safeParse(json);
  if (!parsed.success)
    return `${SETTINGS_FILE} is not a valid settings file (its env must map names to strings)`;
  const refused = [
    ...Object.keys(parsed.data.env ?? {}).filter(refusedEnvName),
    ...REFUSED_COMMAND_KEYS.filter((key) => key in parsed.data),
    ...REFUSED_HOOK_KEYS.filter((key) => key in parsed.data),
  ];
  if (refused.length === 0) return null;
  return `${SETTINGS_FILE} sets ${refused.join(', ')}, which would change who is billed, where requests go or what they pass through, or turn off the hooks that check them`;
}
