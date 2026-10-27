import { existsSync, realpathSync, type Dirent } from 'node:fs';
import { readdir, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { PermissionRuleDto, ProjectDto } from '@10db/contracts';
import { foldPathCase } from '../guard';
import { MISE_SYSTEM_DIRS } from './mise-config';
import { isSandboxDomain, isSandboxPath, SandboxProfileError } from './profile';
import { isEqualOrUnder, protectedReads } from './protected-reads';
import { toolchainAccess, type ToolchainAccess } from './toolchain-reads';

/** What every sandbox of one project is built from, whatever runs in it: a lane's Bash or the gate. */
export interface ProjectAccess {
  /** The checkout's real path. */
  readonly checkout: string;
  /** The checkout's `.env*` files, and the real paths of its `.env*` links. */
  readonly checkoutSecrets: readonly string[];
  readonly protectedReads: readonly string[];
  readonly toolchain: ToolchainAccess;
  /** The hosts the project's stored rules allow. */
  readonly hosts: readonly string[];
  /** The read paths the project's stored rules allow. */
  readonly readList: readonly string[];
  /** A linked worktree's common dir, which its read-only git reads; empty in an ordinary checkout. */
  readonly gitReads: readonly string[];
  /**
   * Git state no sandboxed process may write: the checkout's git dir, its common dir and
   * `<checkout>/.git`, and those of every other registered checkout.
   */
  readonly gitState: readonly string[];
}

export interface ProjectAccessDeps {
  readonly home: string;
  readonly dataDir: string;
  /** The config dir of the login shell's own Claude Code sign-in, when it isn't the default. */
  readonly loginConfigDir: string | null;
  /** Where sandbox temp dirs are made: PATH entries in it are dropped like a checkout's. */
  readonly tmpRoot: string;
  /** The checkout's git dir and common dir, from `git/`. */
  readonly gitDirs: (
    repoPath: string,
  ) => Promise<{ readonly gitDir: string; readonly commonDir: string }>;
  /** The install prefixes probed for node; tests pass their own. */
  readonly systemPrefixes?: readonly string[];
}

export interface ProjectAccessInput {
  readonly project: Pick<ProjectDto, 'repoPath'>;
  /** The env the sandboxed commands' toolchain is read from. */
  readonly env: Readonly<Record<string, string>>;
  /** The project's (and a lane's workstream's) stored permission rules. */
  readonly rules: readonly Pick<PermissionRuleDto, 'toolName' | 'pattern'>[];
  /** Config dirs of the accounts in play, denied with the login's own. */
  readonly configDirs: readonly string[];
  /**
   * Every project's checkout. A sandboxed process can write its own, so a PATH entry inside any of
   * them is dropped before the toolchain is read: no project can change another's profile.
   */
  readonly checkouts: readonly string[];
}

const NETWORK_TOOL = 'SandboxNetworkAccess';
/** Folded the way the file system folds names, so `.ENV` is caught where it is the same file. */
const SECRET_FILE_PREFIX = foldPathCase('.env');
const UNWALKED_DIRECTORIES: ReadonlySet<string> = new Set(['node_modules', '.git']);
/** Listing errors that mean the directory is gone, so it can hide no secret file. */
const VANISHED: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);

type ListDirectory = (dir: string) => Promise<Dirent[]>;
const listDirectory: ListDirectory = (dir) => readdir(dir, { withFileTypes: true });

function errorCode(error: unknown): string | null {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null;
}

/**
 * The paths a `.env*` entry names: the file itself, or a link and the real path it leads to. A
 * link that can't be resolved (dangling, or a loop) leads to nothing to read, so it names none.
 */
async function secretPathsOf(path: string, entry: Dirent): Promise<string[]> {
  if (!entry.isSymbolicLink()) return [path];
  try {
    return [path, await realpath(path)];
  } catch {
    return [];
  }
}

/**
 * Every `.env*` file under `root`, and every `.env*` link with the real path it leads to;
 * directories in `UNWALKED_DIRECTORIES` and links are not entered. The walk is asynchronous, as a
 * checkout can hold a large build tree. A directory that vanished mid-walk is skipped; one that
 * can't be listed for any other reason could hide a secret file, so the walk refuses, naming it.
 */
export async function secretFilesIn(
  root: string,
  list: ListDirectory = listDirectory,
): Promise<string[]> {
  const found = new Set<string>();
  const pending = [root];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    let entries: Dirent[];
    try {
      entries = await list(dir);
    } catch (error) {
      const code = errorCode(error);
      if (code !== null && VANISHED.has(code)) continue;
      throw new SandboxProfileError(
        'secretFiles',
        `a directory in the checkout can't be listed: ${relative(root, dir) || '.'}`,
      );
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!UNWALKED_DIRECTORIES.has(entry.name)) pending.push(path);
      } else if (foldPathCase(entry.name).startsWith(SECRET_FILE_PREFIX)) {
        for (const secret of await secretPathsOf(path, entry)) found.add(secret);
      }
    }
  }
  return [...found].sort();
}

export function realCheckoutOf(checkout: string): string {
  try {
    return realpathSync(checkout);
  } catch {
    throw new SandboxProfileError('checkout', "the checkout can't be read");
  }
}

/** The patterns of the stored rules for `toolName` that a sandbox field can carry; others are left out. */
function storedPatterns(
  rules: ProjectAccessInput['rules'],
  toolName: string,
  accepts: (value: string) => boolean,
): string[] {
  const patterns = rules.flatMap((rule) =>
    rule.toolName === toolName && rule.pattern !== null && accepts(rule.pattern)
      ? [rule.pattern]
      : [],
  );
  return [...new Set(patterns)];
}

/**
 * `<checkout>/.git`, the git dir and the common dir of every registered checkout but `own`. A checkout
 * whose git dirs can't be read now still gets its `.git` denied, and one that is gone is skipped.
 */
async function otherCheckoutsGitState(
  own: string,
  checkouts: readonly string[],
  gitDirs: ProjectAccessDeps['gitDirs'],
): Promise<string[]> {
  // A checkout that is gone has nothing to protect.
  const real = checkouts.flatMap((path) => (existsSync(path) ? [realpathSync(path)] : []));
  const others = [...new Set(real)].filter((path) => path !== own);
  const denies = await Promise.all(
    others.map(async (other) => {
      const dirs = await gitDirs(other).catch(() => null);
      return [join(other, '.git'), ...(dirs ? [dirs.gitDir, dirs.commonDir] : [])];
    }),
  );
  return denies.flat();
}

/** Reads what one project's sandboxes are built from; nothing is created. */
export async function projectAccess(
  deps: ProjectAccessDeps,
  input: ProjectAccessInput,
): Promise<ProjectAccess> {
  const checkout = realCheckoutOf(input.project.repoPath);
  const checkoutSecrets = await secretFilesIn(checkout);
  const { gitDir, commonDir } = await deps.gitDirs(checkout);
  const linkedWorktree = !isEqualOrUnder(commonDir, checkout);
  const otherGitState = await otherCheckoutsGitState(checkout, input.checkouts, deps.gitDirs);
  const protectedList = [
    ...protectedReads({
      home: deps.home,
      dataDir: deps.dataDir,
      configDirs: [
        ...input.configDirs,
        ...(deps.loginConfigDir === null ? [] : [deps.loginConfigDir]),
      ],
    }),
    ...MISE_SYSTEM_DIRS,
  ];
  const untrustedRoots = [...input.checkouts, deps.tmpRoot].flatMap((path) => {
    try {
      return [path, realpathSync(path)];
    } catch {
      return [path];
    }
  });
  const toolchain = toolchainAccess(deps.home, input.env, protectedList, {
    untrustedRoots,
    ...(deps.systemPrefixes === undefined ? {} : { systemPrefixes: deps.systemPrefixes }),
  });
  return {
    checkout,
    checkoutSecrets,
    protectedReads: protectedList,
    toolchain,
    hosts: storedPatterns(input.rules, NETWORK_TOOL, isSandboxDomain),
    readList: storedPatterns(input.rules, 'Read', isSandboxPath),
    gitReads: linkedWorktree ? [commonDir] : [],
    // Only the daemon writes git state, so a sandboxed process can't move HEAD or a ref, stage, or
    // plant config, hooks, alternates or attributes: the git dir and the common dir are read-only to
    // it, and so is `<checkout>/.git`, file or directory, wherever the git dir lies, so a gitfile
    // can't be swapped to point elsewhere. Every other registered checkout's are denied too: one
    // nested in this checkout would otherwise be writable here, and the daemon's git trusts a git
    // dir under any of them.
    gitState: [...new Set([join(checkout, '.git'), gitDir, commonDir, ...otherGitState])],
  };
}
