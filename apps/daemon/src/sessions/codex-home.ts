import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { z } from 'zod';
import { singleQuoted } from '../sandbox';

/** Above the longest wait for a card: `humanWaitMinutes` is at most 240, plus the 5 of the tool timeout. */
export const CODEX_HOOK_TIMEOUT_SECONDS = 15_000;

/** The event name `hooks/list` reports for the guard hook. */
export const GUARD_HOOK_EVENT = 'preToolUse';

export interface CodexHome {
  readonly path: string;
  /** The empty folder the child runs with as HOME. */
  readonly emptyHome: string;
  /** Writes config.toml and guard-hook.sh when they differ, and pins the checkout untrusted. */
  prepare(checkout: string): Promise<void>;
  /** Records the hash Codex reports for 10db's hook. */
  trustGuardHook(key: string, hash: string): Promise<void>;
}

/** A Codex home that cannot be written: its config file is unreadable. */
export class CodexHomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexHomeError';
  }
}

const GUARD_HOOK_SCRIPT = `#!/bin/sh
# Codex runs the tool on every exit but 2, so each failure here refuses the call.
answer=$(/usr/bin/curl --silent --fail --max-time "$TENDB_GUARD_MAX_SECONDS" \\
  --unix-socket "$TENDB_GUARD_SOCKET" --data-binary @- http://10db/pre-tool-use) || {
  echo '10db could not check this call, so it was refused.' >&2
  exit 2
}
printf '%s' "$answer"
`;

/** What 10db keeps of a file Codex may have changed: the trust it recorded and the checkouts it knows. */
const ExistingConfig = z.looseObject({
  projects: z.record(z.string(), z.unknown()).optional(),
  hooks: z.looseObject({ state: z.record(z.string(), z.unknown()).optional() }).optional(),
});

interface KeptConfig {
  readonly projects: Record<string, unknown>;
  readonly state: Record<string, unknown>;
}

const MODE_HOME = 0o700;
const MODE_SCRIPT = 0o755;
const MODE_CONFIG = 0o600;

function template(home: string): Record<string, unknown> {
  return {
    forced_login_method: 'chatgpt',
    default_permissions: 'lane',
    allow_login_shell: false,
    web_search: 'disabled',
    features: {
      network_proxy: true,
      goals: false,
      memories: false,
      apps: false,
      plugins: false,
    },
    agents: { enabled: false },
    skills: { include_instructions: false },
    shell_environment_policy: { inherit: 'none' },
    permissions: { lane: { filesystem: { ':minimal': 'read' } } },
    hooks: {
      PreToolUse: [
        {
          hooks: [
            {
              type: 'command',
              timeout: CODEX_HOOK_TIMEOUT_SECONDS,
              command: `/bin/sh ${singleQuoted(join(home, 'guard-hook.sh'))}`,
            },
          ],
        },
      ],
    },
  };
}

async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Replaces `file` with `content` through a temp file renamed over it, unless it already holds it. */
async function writeAtomically(file: string, content: string, mode: number): Promise<void> {
  if ((await readIfPresent(file)) === content) {
    await chmod(file, mode);
    return;
  }
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temp, content, { mode });
    await chmod(temp, mode);
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

function readKept(text: string | null): KeptConfig {
  if (text === null) return { projects: {}, state: {} };
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch {
    throw new CodexHomeError('config.toml in the Codex home is not valid TOML');
  }
  const existing = ExistingConfig.safeParse(parsed);
  if (!existing.success) {
    throw new CodexHomeError('config.toml in the Codex home has an unexpected shape');
  }
  return {
    projects: { ...existing.data.projects },
    state: { ...existing.data.hooks?.state },
  };
}

class FileCodexHome implements CodexHome {
  readonly path: string;
  readonly emptyHome: string;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
    this.emptyHome = join(path, 'home');
  }

  prepare(checkout: string): Promise<void> {
    return this.enqueue(async () => {
      const real = await realpath(checkout);
      await this.ensureFolders();
      await writeAtomically(join(this.path, 'guard-hook.sh'), GUARD_HOOK_SCRIPT, MODE_SCRIPT);
      await this.writeConfig((kept) => {
        kept.projects[real] = { trust_level: 'untrusted' };
      });
    });
  }

  trustGuardHook(key: string, hash: string): Promise<void> {
    return this.enqueue(async () => {
      await this.ensureFolders();
      await this.writeConfig((kept) => {
        kept.state[key] = { trusted_hash: hash };
      });
    });
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    const run = this.tail.then(job);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async ensureFolders(): Promise<void> {
    await mkdir(this.emptyHome, { recursive: true, mode: MODE_HOME });
    await chmod(this.path, MODE_HOME);
    await chmod(this.emptyHome, MODE_HOME);
  }

  /** Overlays the template on what Codex kept, applies `change`, and writes the result if it differs. */
  private async writeConfig(change: (kept: KeptConfig) => void): Promise<void> {
    const file = join(this.path, 'config.toml');
    const kept = readKept(await readIfPresent(file));
    change(kept);
    const base = template(this.path);
    const hooks = base['hooks'] as Record<string, unknown>;
    if (Object.keys(kept.state).length > 0) hooks['state'] = kept.state;
    await writeAtomically(file, stringify({ ...base, projects: kept.projects }), MODE_CONFIG);
  }
}

/** Hands out the home for a path; each home is one object, so its writes share one queue. */
export function codexHomes(): (path: string) => CodexHome {
  const homes = new Map<string, FileCodexHome>();
  return (path) => {
    const key = resolve(path);
    let home = homes.get(key);
    if (home === undefined) {
      home = new FileCodexHome(key);
      homes.set(key, home);
    }
    return home;
  };
}
