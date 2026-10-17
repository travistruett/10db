import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { join } from 'node:path';
import { SystemCheckDto, ToolName } from '@10db/contracts';
import type { LoginEnv } from './login-env';

const VERSION_PROBE_TIMEOUT_MS = 5_000;

export const REQUIRED_TOOLS = [
  { name: ToolName.Claude, required: true },
  { name: ToolName.Git, required: true },
  { name: ToolName.Docker, required: false },
] as const;

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

export async function systemCheck(
  login: LoginEnv,
  probe: VersionProbe = probeVersion,
): Promise<SystemCheckDto> {
  const tools = await Promise.all(
    REQUIRED_TOOLS.map(async (tool) => {
      const path = findOnPath(tool.name, login.vars['PATH']);
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
    tools,
  });
}
