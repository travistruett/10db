import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  readRepoConfigFileIn,
  REPO_CONFIG_MAX_BYTES,
  RepoConfigFileError,
} from './repo-config-file';

const SETTINGS_FILE = join('.claude', 'settings.json');
const LOCAL_SETTINGS_FILE = join('.claude', 'settings.local.json');
/** The provider switches whose value `0` or `false` leaves everything where it was. */
const PROVIDER_SWITCHES = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'] as const;
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

const SWITCHED_OFF = new Set(['0', 'false']);

/** A provider switch set off moves nothing: it is how a repo or a builder says "not Bedrock here". */
function switchedOff(name: string, value: string | undefined): boolean {
  return (
    value !== undefined &&
    PROVIDER_SWITCHES.some((switchName) => switchName === name.toUpperCase()) &&
    SWITCHED_OFF.has(value.trim().toLowerCase())
  );
}

/**
 * Why a settings file named `label` must not be loaded, or null. Claude Code applies a settings file's `env`
 * block to the session after 10db has stripped the same names from the login environment, and no account check
 * would show it. A missing file (`read` returns null) is fine; an unreadable or invalid one fails closed, as
 * does anything but a regular file under the size cap. Names are reported, never values.
 */
function settingsFileProblem(label: string, read: () => string | null): string | null {
  let text: string | null;
  try {
    text = read();
  } catch (error) {
    if (!(error instanceof RepoConfigFileError)) throw error;
    return `${label} could not be read (${error.message})`;
  }
  if (text === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return `${label} is not valid JSON`;
  }
  const parsed = ProjectSettings.safeParse(json);
  if (!parsed.success)
    return `${label} is not a valid settings file (its env must map names to strings)`;
  const refused = [
    ...Object.entries(parsed.data.env ?? {})
      .filter(([name, value]) => refusedEnvName(name) && !switchedOff(name, value))
      .map(([name]) => name),
    ...REFUSED_COMMAND_KEYS.filter((key) => key in parsed.data),
    ...REFUSED_HOOK_KEYS.filter((key) => key in parsed.data),
  ];
  if (refused.length === 0) return null;
  return `${label} sets ${refused.join(', ')}, which would change who is billed, where requests go or what they pass through, or turn off the hooks that check them`;
}

const repoFileProblem = (cwd: string, relative: string): string | null =>
  settingsFileProblem(relative, () => readRepoConfigFileIn(cwd, relative));

/** The builder's own settings file: it may be a link into their dotfiles, which a repo's file may not be. */
function userSettingsText(file: string): string | null {
  let stat;
  try {
    stat = statSync(file);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : null;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw new RepoConfigFileError(typeof code === 'string' ? code : 'error');
  }
  if (!stat.isFile()) throw new RepoConfigFileError('it must be a regular file');
  if (stat.size > REPO_CONFIG_MAX_BYTES)
    throw new RepoConfigFileError(`it is larger than ${String(REPO_CONFIG_MAX_BYTES / 1024)} KiB`);
  try {
    return readFileSync(file, 'utf8');
  } catch {
    throw new RepoConfigFileError('error');
  }
}

/**
 * Whether the repo's committed `.claude/settings.json` could change who is billed or where requests go (a lane
 * that loads project settings). Returns why the session must not start, or null.
 */
export function projectSettingsBillingProblem(cwd: string): string | null {
  return repoFileProblem(cwd, SETTINGS_FILE);
}

/**
 * The same check over every settings file a Full access chat loads: the project's, its local one and the
 * user's, which sits in the account's config folder `userConfigDir`. The first problem found is returned.
 */
export function fullAccessSettingsBillingProblem(
  cwd: string,
  userConfigDir: string,
): string | null {
  return (
    repoFileProblem(cwd, SETTINGS_FILE) ??
    repoFileProblem(cwd, LOCAL_SETTINGS_FILE) ??
    settingsFileProblem('settings.json in the account’s config folder', () =>
      userSettingsText(join(userConfigDir, 'settings.json')),
    )
  );
}
