import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { join } from 'node:path';
import { SystemCheckDto, ToolName } from '@10db/contracts';
import { INSTALL_PREFIXES } from '../git';
import { ACCOUNT_NAMES_VERIFIED_ON } from './launch';
import type { LoginEnv } from './login-env';

const VERSION_PROBE_TIMEOUT_MS = 5_000;

export const REQUIRED_TOOLS = [
  { name: ToolName.Claude, required: true },
  { name: ToolName.Git, required: true },
  { name: ToolName.Docker, required: false },
  // Required only while a project delivers pull requests (markGhRequired).
  { name: ToolName.Gh, required: false },
] as const;

/** gh is needed once any project ships pull requests (batch delivery spec §6). */
export function markGhRequired(check: SystemCheckDto, needed: boolean): SystemCheckDto {
  return {
    ...check,
    tools: check.tools.map((t) => (t.name === ToolName.Gh ? { ...t, required: needed } : t)),
  };
}

/** The first executable file called `name` on `pathVar`, like `command -v`. */
export function findOnPath(name: string, pathVar: string | undefined): string | null {
  for (const dir of (pathVar ?? '').split(':')) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not here; keep looking.
    }
  }
  return null;
}

export type VersionProbe = (
  path: string,
  env: Readonly<Record<string, string>>,
) => Promise<string | null>;

/** The first non-empty line of `<path> --version`, or null if the tool fails or times out. */
export const probeVersion: VersionProbe = (path, env) =>
  new Promise((resolve) => {
    execFile(
      path,
      ['--version'],
      { timeout: VERSION_PROBE_TIMEOUT_MS, encoding: 'utf8', env: { ...env } },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(
          stdout
            .split('\n')
            .map((line) => line.trim())
            .find((line) => line.length > 0) ?? null,
        );
      },
    );
  });

const major = (version: string | null): number | null => {
  const match = /^(\d+)\.\d+\.\d+/.exec(version ?? '');
  return match?.[1] === undefined ? null : Number(match[1]);
};

/** A newer major Claude Code may rename the variables or fields the account checks rely on. */
export function claudeCodeWarning(version: string | null): string | null {
  const installed = major(version);
  const verified = major(ACCOUNT_NAMES_VERIFIED_ON);
  if (installed === null || verified === null || installed <= verified) return null;
  return `Claude Code ${version ?? ''} is a newer major version than ${ACCOUNT_NAMES_VERIFIED_ON}, the version 10db's account checks were verified on. Sessions that report unexpected credentials are refused until the live check is rerun on it.`;
}

export async function systemCheck(
  login: LoginEnv,
  probe: VersionProbe = probeVersion,
): Promise<SystemCheckDto> {
  const tools = await Promise.all(
    REQUIRED_TOOLS.map(async (tool) => {
      // git and gh come from the prefixes the daemon runs them from, never the login PATH, so no git
      // or gh a lane put on it runs here either.
      const path = findOnPath(
        tool.name,
        tool.name === ToolName.Git || tool.name === ToolName.Gh
          ? INSTALL_PREFIXES.join(':')
          : login.vars['PATH'],
      );
      return {
        name: tool.name,
        path,
        version: path ? await probe(path, login.vars) : null,
        required: tool.required,
      };
    }),
  );
  return SystemCheckDto.parse({
    loginEnv: { source: login.source, warning: login.warning },
    claudeCode: {
      verifiedOn: ACCOUNT_NAMES_VERIFIED_ON,
      warning: claudeCodeWarning(tools.find((t) => t.name === ToolName.Claude)?.version ?? null),
    },
    tools,
  });
}
