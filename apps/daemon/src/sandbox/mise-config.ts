import { readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { z } from 'zod';

/** Where the builder's mise keeps its config, installs, state and cache. */
export interface MiseDirs {
  readonly config: string;
  readonly globalConfigFile: string;
  readonly data: string;
  readonly state: string;
  readonly cache: readonly string[];
}

/** An absolute path a variable names, or null when it is unset or relative. */
function named(env: Readonly<Record<string, string>>, variable: string): string | null {
  const value = env[variable] ?? '';
  return value !== '' && isAbsolute(value) ? resolve(value) : null;
}

/**
 * mise's dirs as mise finds them: its own variable, else the XDG base dir, else the default under
 * home. With no variable set, mise's cache is `~/.cache/mise` or, on macOS, `~/Library/Caches/mise`.
 */
export function miseDirs(home: string, env: Readonly<Record<string, string>>): MiseDirs {
  const xdg = (variable: string): string | null => {
    const base = named(env, variable);
    return base === null ? null : join(base, 'mise');
  };
  const config =
    named(env, 'MISE_CONFIG_DIR') ?? xdg('XDG_CONFIG_HOME') ?? join(home, '.config', 'mise');
  const cache = named(env, 'MISE_CACHE_DIR') ?? xdg('XDG_CACHE_HOME');
  return {
    config,
    globalConfigFile: named(env, 'MISE_GLOBAL_CONFIG_FILE') ?? join(config, 'config.toml'),
    data:
      named(env, 'MISE_DATA_DIR') ?? xdg('XDG_DATA_HOME') ?? join(home, '.local', 'share', 'mise'),
    state:
      named(env, 'MISE_STATE_DIR') ??
      xdg('XDG_STATE_HOME') ??
      join(home, '.local', 'state', 'mise'),
    cache:
      cache === null
        ? [join(home, '.cache', 'mise'), join(home, 'Library', 'Caches', 'mise')]
        : [cache],
  };
}

const Versions = z.union([z.string(), z.array(z.string())]);
/** A tool entry: a version, a list of them, or a table whose `version` alone is kept. */
const ToolEntry = z.union([Versions, z.looseObject({ version: Versions })]);
const GlobalConfig = z.looseObject({ tools: z.record(z.string(), z.unknown()).optional() });

type ToolVersions = Record<string, string | string[]>;

/**
 * The versions in one mise TOML file's `[tools]`. A key with `[` carries inline backend options
 * (`aqua:cli/cli[exe=gh]`) and is dropped with them; an entry with no version is dropped.
 */
function tomlTools(file: string): ToolVersions {
  let parsed: unknown;
  try {
    parsed = parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
  const config = GlobalConfig.safeParse(parsed);
  if (!config.success || config.data.tools === undefined) return {};
  const tools: ToolVersions = {};
  for (const [name, value] of Object.entries(config.data.tools)) {
    if (name.includes('[')) continue;
    const entry = ToolEntry.safeParse(value);
    if (!entry.success) continue;
    tools[name] =
      typeof entry.data === 'string' || Array.isArray(entry.data) ? entry.data : entry.data.version;
  }
  return tools;
}

/** The versions in a `.tool-versions` file: `<tool> <version>...` per line, `#` starting a comment. */
function toolVersionsFile(file: string): ToolVersions {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  const tools: ToolVersions = {};
  for (const line of text.split('\n')) {
    const [name, ...versions] = (line.split('#')[0] ?? '').trim().split(/\s+/);
    if (name === undefined || name === '' || name.includes('[') || versions.length === 0) continue;
    tools[name] = versions.length === 1 ? (versions[0] ?? '') : versions;
  }
  return tools;
}

function confDFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.toml'))
      .sort()
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

/**
 * The global mise config a lane gets, as TOML: the builder's global tool versions and nothing else.
 * `[env]`, `[vars]`, `[tasks]`, `[hooks]`, `[settings]` and every tool option (a `postinstall`
 * command, an `install_env`) stay out, so neither a token nor a command in the builder's config
 * reaches a lane. The sources merge in mise's own order, measured with mise itself, the later one
 * winning: `conf.d/*.toml` alphabetically, `config.toml` (or `MISE_GLOBAL_CONFIG_FILE`),
 * `config.<MISE_ENV>.toml`, `config.local.toml`, then `~/.tool-versions`, which a lane's checkout
 * under home also inherits. A source that is missing or not TOML adds nothing.
 */
export function laneMiseConfig(home: string, env: Readonly<Record<string, string>>): string {
  const dirs = miseDirs(home, env);
  const miseEnv = env['MISE_ENV'] ?? '';
  const tools: ToolVersions = {};
  const layers = [
    ...confDFiles(join(dirs.config, 'conf.d')).map(tomlTools),
    tomlTools(dirs.globalConfigFile),
    ...(/^[\w.-]+$/.test(miseEnv) ? [tomlTools(join(dirs.config, `config.${miseEnv}.toml`))] : []),
    tomlTools(join(dirs.config, 'config.local.toml')),
    toolVersionsFile(join(home, '.tool-versions')),
  ];
  for (const layer of layers) Object.assign(tools, layer);
  return Object.keys(tools).length === 0 ? '' : stringify({ tools });
}

/**
 * mise's system config dir, as spelled on macOS and through its link: its `config.toml` can carry
 * `[env]` and `[hooks]`, so lanes are denied it and mise is pointed at the lane's own dir instead.
 */
export const MISE_SYSTEM_DIRS = ['/etc/mise', '/private/etc/mise'] as const;

const AGE_KEY_VARIABLE = /^MISE_.*AGE_KEY_FILE$/;

/** mise's age keys, which decrypt its secrets: `age.txt` in its config dir and any file a variable names. */
export function miseKeyFiles(dirs: MiseDirs, env: Readonly<Record<string, string>>): string[] {
  const named = Object.entries(env)
    .filter(([name, value]) => AGE_KEY_VARIABLE.test(name) && isAbsolute(value))
    .map(([, value]) => resolve(value));
  return [join(dirs.config, 'age.txt'), ...named];
}
