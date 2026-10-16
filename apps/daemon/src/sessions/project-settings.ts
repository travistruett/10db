import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { isBillingSwitch } from '../environment';

const SETTINGS_FILE = join('.claude', 'settings.json');
/** Only `env` matters here; every other key passes through. */
const ProjectSettings = z.looseObject({ env: z.record(z.string(), z.string()).optional() });

/** The `code` of a Node file-system error, or undefined for anything else. */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

/**
 * Whether the repo's committed `.claude/settings.json` could change who is billed or where requests go.
 * Claude Code applies its `env` block to the session after 10db has stripped the same names from the login
 * environment, and no account check would show it. Returns why the session must not start, or null. A missing
 * file is fine; an unreadable or invalid one fails closed. Names are reported, never values.
 */
export function projectSettingsBillingProblem(cwd: string): string | null {
  const path = join(cwd, SETTINGS_FILE);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    return `${SETTINGS_FILE} could not be read (${code ?? 'error'})`;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return `${SETTINGS_FILE} is not valid JSON`;
  }
  const parsed = ProjectSettings.safeParse(json);
  if (!parsed.success)
    return `${SETTINGS_FILE} is not a valid settings file (its env must map names to strings)`;
  const switches = Object.keys(parsed.data.env ?? {}).filter(isBillingSwitch);
  if (switches.length === 0) return null;
  return `${SETTINGS_FILE} sets ${switches.join(', ')}, which would change who is billed or where requests go`;
}
