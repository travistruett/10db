import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SystemCheckDto, ToolName } from '@10db/contracts';
import { firstExecutable, installCandidates } from '../git';
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

/**
 * Where claude is looked for: the install prefixes, then Claude Code's own install directories in
 * `home`. Never the login PATH, which can lead with a directory a lane writes.
 */
function claudeCandidates(home: string): string[] {
  return [
    ...installCandidates('claude'),
    join(home, '.local', 'bin', 'claude'),
    join(home, '.claude', 'local', 'claude'),
  ];
}

/** The claude the daemon runs sessions with, or null when none is installed where it looks. */
export function findClaude(home: string = homedir()): string | null {
  return firstExecutable(claudeCandidates(home));
}

/** Docker Desktop links docker into `/usr/local/bin`, or into `~/.docker/bin` for a user install. */
function findDocker(home: string): string | null {
  return firstExecutable([...installCandidates('docker'), join(home, '.docker', 'bin', 'docker')]);
}

/** The git and gh the daemon resolved at startup and runs for every call. */
export interface ResolvedTools {
  readonly git: string;
  readonly gh: string | null;
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
  resolved: ResolvedTools,
  opts: { readonly home?: string; readonly probe?: VersionProbe } = {},
): Promise<SystemCheckDto> {
  const home = opts.home ?? homedir();
  const probe = opts.probe ?? probeVersion;
  // Each tool is the one the daemon runs, found where no lane writes, so no tool a lane put on the
  // login PATH runs here, not even for its version.
  const pathOf = (name: ToolName): string | null => {
    switch (name) {
      case ToolName.Claude:
        return findClaude(home);
      case ToolName.Git:
        return resolved.git;
      case ToolName.Gh:
        return resolved.gh;
      case ToolName.Docker:
        return findDocker(home);
    }
  };
  const tools = await Promise.all(
    REQUIRED_TOOLS.map(async (tool) => {
      const path = pathOf(tool.name);
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
