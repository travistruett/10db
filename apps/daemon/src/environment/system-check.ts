import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SystemCheckDto, ToolName } from '@10db/contracts';
import { firstExecutable, installCandidates } from '../git';
import { CODEX_VERIFIED_ON } from './agent-pins';
import { ACCOUNT_NAMES_VERIFIED_ON } from './launch';
import type { LoginEnv } from './login-env';
import type { AgentStatus } from './pinned-tools';

const VERSION_PROBE_TIMEOUT_MS = 5_000;

export const REQUIRED_TOOLS = [
  { name: ToolName.Claude, required: true },
  // Needed only by a project on a ChatGPT plan, so a missing codex is reported but never blocks.
  { name: ToolName.Codex, required: false },
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
 * The claude and codex rows and the pinned copies, from what the daemon runs now. Read for each request,
 * not kept with the tool check, because a copy is fetched in the background and a newer release can appear
 * at any time. The builder's own installs are never looked at: lanes run the pinned copies.
 */
export function withAgentStatus(
  check: SystemCheckDto,
  statuses: readonly AgentStatus[],
): SystemCheckDto {
  const of = (name: ToolName) => statuses.find((s) => s.tool === name);
  const tools = check.tools.map((tool) => {
    const status =
      tool.name === ToolName.Claude || tool.name === ToolName.Codex ? of(tool.name) : undefined;
    return status ? { ...tool, path: status.path, version: status.version } : tool;
  });
  return {
    ...check,
    claudeCode: {
      ...check.claudeCode,
      warning: claudeCodeWarning(of(ToolName.Claude)?.version ?? null),
    },
    codex: { ...check.codex, warning: codexWarning(of(ToolName.Codex)?.version ?? null) },
    tools,
    agents: statuses.map((s) => ({
      tool: s.tool,
      label: s.label,
      pinned: s.pinned,
      state: s.state,
      problem: s.problem,
      newerRelease: s.newerRelease,
    })),
  };
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

/** Any Codex version but the verified one may have changed the app-server messages 10db reads. */
export function codexWarning(version: string | null): string | null {
  const installed = /\d+\.\d+\.\d+/.exec(version ?? '')?.[0];
  if (installed === undefined || installed === CODEX_VERIFIED_ON) return null;
  return `Codex ${installed} is not ${CODEX_VERIFIED_ON}, the version 10db's ChatGPT-plan checks were verified on. Sessions that fail a start check are refused until the live check is rerun on it.`;
}

/** Asks gh who is signed in: the login, null when signed out, a throw when it can't tell. */
export type GhLoginProbe = () => Promise<string | null>;

/** A probe that can't tell (no network, a timeout) leaves the login unknown rather than failing the check. */
async function signedInAs(ghLogin: GhLoginProbe | undefined): Promise<string | null> {
  if (!ghLogin) return null;
  try {
    return await ghLogin();
  } catch {
    return null;
  }
}

export async function systemCheck(
  login: LoginEnv,
  resolved: ResolvedTools,
  opts: {
    readonly home?: string;
    readonly probe?: VersionProbe;
    readonly ghLogin?: GhLoginProbe;
  } = {},
): Promise<SystemCheckDto> {
  const home = opts.home ?? homedir();
  const probe = opts.probe ?? probeVersion;
  // Each tool is the one the daemon runs, found where no lane writes, so no tool a lane put on the
  // login PATH runs here, not even for its version. Claude Code and Codex are the pinned copies,
  // filled in by `withAgentStatus`.
  const pathOf = (name: ToolName): string | null => {
    switch (name) {
      case ToolName.Claude:
      case ToolName.Codex:
        return null;
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
        signedIn: tool.name === ToolName.Gh && path ? await signedInAs(opts.ghLogin) : null,
      };
    }),
  );
  return SystemCheckDto.parse({
    loginEnv: { source: login.source, warning: login.warning },
    claudeCode: {
      verifiedOn: ACCOUNT_NAMES_VERIFIED_ON,
      warning: claudeCodeWarning(tools.find((t) => t.name === ToolName.Claude)?.version ?? null),
    },
    codex: {
      verifiedOn: CODEX_VERIFIED_ON,
      warning: codexWarning(tools.find((t) => t.name === ToolName.Codex)?.version ?? null),
    },
    tools,
  });
}
