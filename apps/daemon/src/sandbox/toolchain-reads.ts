import { lstatSync, readdirSync, realpathSync, statSync, type Dirent } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { miseDirs, miseKeyFiles } from './mise-config';
import { isSandboxPath, SandboxProfileError } from './profile';
import { isEqualOrUnder, pathsEqual } from './protected-reads';

/** Home dirs too broad to open whole or to treat as a toolchain's home. */
const BROAD_UNDER_HOME = [
  ['.config'],
  ['.local'],
  ['.local', 'share'],
  ['.local', 'state'],
  ['.cache'],
  ['Library'],
  ['Library', 'Application Support'],
  ['Library', 'Caches'],
  ['Documents'],
  ['Desktop'],
  ['Downloads'],
] as const;

/**
 * Where a version manager keeps its installs: `<installs>/<tool>/<version>`, or with `installs` null
 * a home that opens whole (rustup's toolchains hold no registry config).
 */
interface Layout {
  /** The manager's home, as the builder's environment names it. */
  readonly home: (home: string, env: Readonly<Record<string, string>>) => string;
  readonly installs: readonly string[] | null;
  /**
   * True when the manager lists its installs dirs itself (mise scans `installs` and each tool's dir
   * on every command, shims included), which Seatbelt allows only for a dir opened whole. The dir
   * opens whole then, and each version's `etc` is denied again.
   */
  readonly listsInstalls: boolean;
  /** Paths in the manager's home that its commands and shims read, opened whole when present. */
  readonly open: readonly (readonly string[])[];
  /** Files beside each tool's versions that the manager reads, such as mise's backend record. */
  readonly toolFiles: readonly string[];
}

/** An absolute dir a variable names, else `fallback` under home. */
function homeFrom(variable: string, fallback: readonly string[]) {
  return (home: string, env: Readonly<Record<string, string>>): string => {
    const value = env[variable] ?? '';
    return value !== '' && isAbsolute(value) ? resolve(value) : join(home, ...fallback);
  };
}

const LAYOUTS: readonly Layout[] = [
  {
    home: (home, env) => miseDirs(home, env).data,
    installs: ['installs'],
    listsInstalls: true,
    open: [['shims']],
    toolFiles: ['.mise.backend.toml'],
  },
  {
    home: homeFrom('NVM_DIR', ['.nvm']),
    installs: ['versions'],
    listsInstalls: false,
    open: [['nvm.sh'], ['alias']],
    toolFiles: [],
  },
  {
    home: homeFrom('VOLTA_HOME', ['.volta']),
    installs: ['tools', 'image'],
    listsInstalls: false,
    open: [['bin'], ['tools', 'user'], ['layout.v4'], ['layout.v3']],
    toolFiles: [],
  },
  {
    home: homeFrom('RUSTUP_HOME', ['.rustup']),
    installs: null,
    listsInstalls: false,
    open: [[]],
    toolFiles: [],
  },
];

/**
 * The real install prefixes outside home: each one's npmrc files are always denied, and each direct
 * child holding `bin/node` has its own denied. Never a temp or other lane-writable dir.
 */
export const SYSTEM_NODE_PREFIXES = ['/usr', '/usr/local', '/opt/homebrew', '/opt/local'] as const;

/** A node install's dir that holds its global config, which can hold a registry token. */
const NEVER_OPENED = 'etc';
/** cargo's files that can hold a registry token or name a program to run. */
const CARGO_SECRETS = ['credentials', 'credentials.toml', 'config', 'config.toml'] as const;

/** A path under `home` (never `home` itself) that is no protected read and holds none. */
function safeUnderHome(path: string, home: string, protectedReads: readonly string[]): boolean {
  return (
    !pathsEqual(path, home) &&
    isEqualOrUnder(path, home) &&
    !protectedReads.some((root) => isEqualOrUnder(path, root) || isEqualOrUnder(root, path))
  );
}

function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function listOrEmpty(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isDirectoryEntry(dir: string, entry: Dirent): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return statSync(join(dir, entry.name)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The real path of `path`, or, when it doesn't exist, the real path of its nearest existing ancestor
 * with the rest appended: how the kernel would resolve it once it exists.
 */
function realOrNearest(path: string): string {
  const real = realOrNull(path);
  if (real !== null) return real;
  const parent = dirname(path);
  return parent === path ? path : join(realOrNearest(parent), basename(path));
}

/** True for a path a lane can write: inside a checkout or the lane temp root, by spelling or real path. */
type Untrusted = (path: string) => boolean;

/** A path and, when it differs, its real path: the kernel judges the real one. */
function bothSpellings(path: string): string[] {
  const real = realOrNull(path);
  return real === null || real === path ? [path] : [path, real];
}

/** The npmrc files a node prefix keeps: its global config and npm's builtin one. */
function npmrcsOf(prefix: string): string[] {
  return [join(prefix, 'etc', 'npmrc'), join(prefix, 'lib', 'node_modules', 'npm', 'npmrc')];
}

interface Access {
  readonly reads: string[];
  readonly secretFiles: string[];
  /** Dirs denied whole, whether or not they exist yet. */
  readonly closed: string[];
}

/**
 * Every entry of each version in `toolDir` except `etc`, by its written path, and by its real path
 * only when that stays inside a granted read: a version linked elsewhere opens by its written path,
 * which the kernel then judges by the real path and refuses. Each version's global and builtin npmrc
 * are denied by both spellings, whether or not they exist yet (a version linked into a Homebrew keg
 * keeps its `etc` there). With `closeEtc`, set where an enclosing dir opens whole, each version's
 * `etc` is denied too, by both spellings.
 */
function versionsAccess(
  toolDir: string,
  granted: readonly string[],
  untrusted: Untrusted,
  closeEtc = false,
): Access {
  const reads: string[] = [];
  const secretFiles: string[] = [];
  const closed: string[] = [];
  if (untrusted(toolDir)) return { reads, secretFiles, closed };
  for (const version of listOrEmpty(toolDir)) {
    if (!isDirectoryEntry(toolDir, version)) continue;
    const written = join(toolDir, version.name);
    const real = realOrNull(written);
    if (real === null || untrusted(written)) continue;
    const realGranted = granted.some((path) => isEqualOrUnder(real, path));
    for (const entry of listOrEmpty(real)) {
      if (entry.name === NEVER_OPENED) continue;
      reads.push(join(written, entry.name));
      if (realGranted) reads.push(join(real, entry.name));
    }
    secretFiles.push(...npmrcsOf(written), ...npmrcsOf(real));
    if (closeEtc) closed.push(join(written, NEVER_OPENED), join(real, NEVER_OPENED));
  }
  return { reads, secretFiles, closed };
}

/**
 * What one manager's layout opens: its fixed paths, each tool's files, and its versions by
 * `versionsAccess`. Listing goes two levels down by the manager's own layout; nothing else is walked,
 * and what isn't listed stays closed.
 */
function layoutAccess(
  layout: Layout,
  root: string,
  granted: readonly string[],
  untrusted: Untrusted,
): Access {
  const reads: string[] = [];
  const secretFiles: string[] = [];
  const closed: string[] = [];
  for (const parts of layout.open) {
    const path = join(root, ...parts);
    if (realOrNull(path) !== null && !untrusted(path)) reads.push(...bothSpellings(path));
  }
  if (layout.installs === null) return { reads, secretFiles, closed };
  const installs = join(root, ...layout.installs);
  const installsReal = realOrNull(installs);
  if (layout.listsInstalls && installsReal !== null && !untrusted(installs)) {
    reads.push(installs);
    if (granted.some((path) => isEqualOrUnder(installsReal, path))) reads.push(installsReal);
  }
  for (const tool of listOrEmpty(installs)) {
    if (!isDirectoryEntry(installs, tool)) continue;
    const toolDir = join(installs, tool.name);
    for (const name of layout.toolFiles) {
      const file = join(toolDir, name);
      if (realOrNull(file) !== null) reads.push(file);
    }
    const versions = versionsAccess(toolDir, granted, untrusted, layout.listsInstalls);
    reads.push(...versions.reads);
    secretFiles.push(...versions.secretFiles);
    closed.push(...versions.closed);
  }
  return { reads, secretFiles, closed };
}

/**
 * A PATH entry under home never opens whole: anything below it could hide a node install and its
 * npmrc. Its own files open (a link among them still resolves where the kernel judges it), and so do
 * pnpm's own installs by layout, never their `etc`: its node installs (`nodejs/<version>`) and its
 * self-updates (`.tools/<package>/<version>`). Its other subdirectories, pnpm's global packages among
 * them, stay closed, and an entry that can't be listed opens nothing.
 */
function pathEntryAccess(entry: string, granted: readonly string[], untrusted: Untrusted): Access {
  const entries = listOrEmpty(entry);
  const reads = entries
    .filter((item) => !isDirectoryEntry(entry, item))
    .map((item) => join(entry, item.name));
  const secretFiles: string[] = [];
  const closed: string[] = [];
  const grantedHere = [...granted, entry];
  const nested = [
    versionsAccess(join(entry, 'nodejs'), grantedHere, untrusted),
    ...listOrEmpty(join(entry, '.tools'))
      .filter((item) => isDirectoryEntry(join(entry, '.tools'), item))
      .map((item) => versionsAccess(join(entry, '.tools', item.name), grantedHere, untrusted)),
  ];
  for (const opened of nested) {
    reads.push(...opened.reads);
    secretFiles.push(...opened.secretFiles);
  }
  return { reads, secretFiles, closed };
}

/**
 * The npmrc files of each node on the lane's PATH, under both the prefix PATH names and the real
 * prefix its binary lives in. Resolved directly, with no walk.
 */
function pathNodeNpmrcs(path: readonly string[]): string[] {
  return path.flatMap((entry) => {
    const real = realOrNull(join(entry, 'node'));
    return real === null ? [] : [dirname(entry), dirname(dirname(real))].flatMap(npmrcsOf);
  });
}

/** Each install prefix's npmrc files, and those of each direct child that holds `bin/node`. */
function systemNpmrcs(prefixes: readonly string[]): string[] {
  return prefixes.flatMap((prefix) => {
    const children = listOrEmpty(prefix)
      .filter((entry) => isDirectoryEntry(prefix, entry))
      .map((entry) => join(prefix, entry.name))
      .filter((child) => realOrNull(join(child, 'bin', 'node')) !== null);
    return [prefix, ...children].flatMap((dir) => bothSpellings(dir).flatMap(npmrcsOf));
  });
}

/** `candidate`, or a refusal when the sandbox profile can't hold its name. */
function expressible(candidate: string): string {
  if (!isSandboxPath(candidate))
    throw new SandboxProfileError(
      'toolchainReads',
      `a toolchain file that can hold a registry token has a name the sandbox profile can't hold: ${candidate}; rename or remove it`,
    );
  return candidate;
}

/**
 * The deny entries for one secret file. A missing file is denied, since it may appear later; a
 * regular file is denied; a link is denied by its path and, when it leads to a regular file, by that
 * file's real path too. A directory or other node there holds no token and is left out, so no probed
 * path can refuse a session by being a directory. A name the profile can't hold refuses the session:
 * the candidates come only from install prefixes, version-manager trees and the builder's own config
 * locations, which lanes can't write.
 */
function deniedSpellings(path: string): string[] {
  let isFile: boolean;
  let isLink: boolean;
  try {
    const stat = lstatSync(path);
    isFile = stat.isFile();
    isLink = stat.isSymbolicLink();
  } catch {
    return [expressible(path)];
  }
  if (isFile) return [expressible(path)];
  if (!isLink) return [];
  const real = realOrNull(path);
  if (real === null) return [expressible(path)];
  let leadsToFile: boolean;
  try {
    leadsToFile = statSync(real).isFile();
  } catch {
    throw new SandboxProfileError(
      'toolchainReads',
      `a toolchain file that can hold a registry token can't be checked: ${path}`,
    );
  }
  return leadsToFile ? [expressible(path), expressible(real)] : [expressible(path)];
}

export interface ToolchainAccess {
  /** What a lane may read of the toolchains, read-only. */
  readonly reads: string[];
  /**
   * Files that can hold a registry token or a key, under those reads or the install prefixes, and
   * the `etc` dirs of mise's versions, closed because its installs dir opens whole.
   */
  readonly secretFiles: string[];
}

export interface ToolchainOptions {
  /** Dirs a lane can write (every project's checkout, the lane temp root): PATH entries in them are dropped. */
  readonly untrustedRoots?: readonly string[];
  /** The install prefixes probed for node; tests pass their own. */
  readonly systemPrefixes?: readonly string[];
}

/**
 * What a lane may read of its toolchains, and the files in reach that it may not. Reads: mise's state
 * and cache dirs (never its config dir: the lane gets its own global config), `~/.cargo/bin`, mise's
 * `installs` dir whole (it lists it on every command), each
 * version manager's installs by its own layout (mise's `installs/<tool>/<version>`, nvm's
 * `versions/node/<version>`, volta's `tools/image/<tool>/<version>`, every entry of each version except
 * `etc`, with the files its shims read), rustup's home whole, and the own files of each PATH entry under
 * home. A home is used only when it lies under home and is neither broad nor protected; a PATH entry in
 * a lane-writable dir is dropped first, so no lane can change another's profile. Secret files: each
 * version's npmrcs, the npmrcs of each node on PATH and of the install prefixes, cargo's credentials and
 * config, and mise's age keys. No read equals or lies under a secret file.
 */
export function toolchainAccess(
  home: string,
  env: Readonly<Record<string, string>>,
  protectedReads: readonly string[],
  options: ToolchainOptions = {},
): ToolchainAccess {
  const broad = BROAD_UNDER_HOME.map((parts) => join(home, ...parts));
  const usable = (dir: string): boolean =>
    safeUnderHome(dir, home, protectedReads) && !broad.some((path) => pathsEqual(path, dir));
  const roots = (options.untrustedRoots ?? []).flatMap((root) => [root, realOrNearest(root)]);
  const untrusted: Untrusted = (path) =>
    [path, realOrNearest(path)].some((spelling) =>
      roots.some((root) => isEqualOrUnder(spelling, root)),
    );
  const mise = miseDirs(home, env);
  // mise's config dir and global config file stay closed whatever a variable names.
  const miseConfig = [mise.config, mise.globalConfigFile].flatMap((path) => [
    path,
    realOrNearest(path),
  ]);
  const touchesMiseConfig = (path: string): boolean =>
    miseConfig.some((config) => isEqualOrUnder(path, config) || isEqualOrUnder(config, path));
  const fixed = [mise.state, ...mise.cache, join(home, '.cargo', 'bin')].filter(usable);
  const managers = LAYOUTS.flatMap((layout) => {
    const root = layout.home(home, env);
    return usable(root) && realOrNull(root) !== null && !untrusted(root) ? [{ layout, root }] : [];
  });
  const managerRoots = managers.map((manager) => manager.root);
  const granted = [...fixed, ...managerRoots];
  const reads: string[] = [...fixed];
  const secretFiles: string[] = [];
  const closed: string[] = [];
  for (const { layout, root } of managers) {
    const opened = layoutAccess(layout, root, granted, untrusted);
    reads.push(...opened.reads);
    secretFiles.push(...opened.secretFiles);
    closed.push(...opened.closed);
  }
  const path = (env['PATH'] ?? '')
    .split(delimiter)
    .filter((entry) => entry !== '' && isAbsolute(entry))
    .map((entry) => resolve(entry))
    .filter((entry) => !untrusted(entry));
  for (const entry of path) {
    if (!usable(entry) || managerRoots.some((root) => isEqualOrUnder(entry, root))) continue;
    const opened = pathEntryAccess(entry, granted, untrusted);
    reads.push(...opened.reads);
    secretFiles.push(...opened.secretFiles);
  }
  const cargoHomes = [join(home, '.cargo'), ...(env['CARGO_HOME'] ? [env['CARGO_HOME']] : [])];
  secretFiles.push(
    ...pathNodeNpmrcs(path),
    ...systemNpmrcs(options.systemPrefixes ?? SYSTEM_NODE_PREFIXES),
    ...cargoHomes.flatMap((dir) => CARGO_SECRETS.map((name) => join(dir, name))),
    ...miseKeyFiles(mise, env),
  );
  const denied = [
    ...new Set([...secretFiles.flatMap(deniedSpellings), ...closed.map(expressible)]),
  ].sort();
  return {
    reads: [
      ...new Set(
        reads.filter(
          (entry) =>
            safeUnderHome(entry, home, protectedReads) &&
            isSandboxPath(entry) &&
            !touchesMiseConfig(entry) &&
            !denied.some((secret) => isEqualOrUnder(entry, secret)),
        ),
      ),
    ],
    secretFiles: denied,
  };
}
