import { existsSync, mkdirSync, realpathSync, writeFileSync, type Dirent } from 'node:fs';
import { readdir, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { PermissionRuleDto, ProjectDto } from '@10db/contracts';
import { foldPathCase } from '../guard';
import { deniedEnvNames } from './env-allowlist';
import { claudeProtectedPaths, type FileAccessContext } from './file-access';
import { laneMiseConfig, MISE_SYSTEM_DIRS } from './mise-config';
import { packageCacheEnv } from './package-cache';
import {
  buildLaneProfile,
  isSandboxDomain,
  isSandboxPath,
  SandboxProfileError,
  type LaneSandboxSettings,
} from './profile';
import { isEqualOrUnder, protectedReads } from './protected-reads';
import { createLaneEnvFile, removeLaneEnvFile } from './env-file';
import {
  createLaneTempDir,
  LANE_TEMP_ROOT,
  removeLaneTempDir,
  SandboxTempDirError,
} from './temp-dir';
import { toolchainAccess } from './toolchain-reads';

/** What a sandboxed session hands Claude Code on top of its ordinary options. */
export interface LaneSandboxSpec {
  readonly settings: LaneSandboxSettings;
  /** Merged over the session's env. */
  readonly env: Readonly<Record<string, string>>;
  readonly disallowedTools: readonly string[];
  /** Permission rules that make Claude Code ask before the call, whatever the allow rules say. */
  readonly askRules: readonly string[];
}

/** One session's sandbox: its profile, its file-tool context and its temp dir. */
export interface LaneSession {
  readonly spec: LaneSandboxSpec;
  /** A live view: `providerSessionId` follows `setProviderSession`. */
  readonly fileAccess: FileAccessContext;
  readonly tmpDir: string;
  setProviderSession(id: string): void;
  /** Removes the temp dir. Run it once the lane process is gone. */
  dispose(): void;
}

export interface LaneSessionInput {
  readonly project: Pick<ProjectDto, 'id' | 'repoPath' | 'sandboxLoopback'>;
  /** The session's launch env, before the sandbox's own is merged over it. */
  readonly env: Readonly<Record<string, string>>;
  /** The project's and the workstream's stored permission rules. */
  readonly rules: readonly Pick<PermissionRuleDto, 'toolName' | 'pattern'>[];
  readonly resumeProviderSessionId: string | null;
  /** The config dir of the account the session runs on, where Claude Code saves its tool results. */
  readonly configDir: string;
  /**
   * Every project's checkout. A lane can write its own, so a PATH entry inside any of them is dropped
   * before the toolchain is read: no lane can change another's profile or refuse its session.
   */
  readonly checkouts: readonly string[];
}

export interface LaneSandbox {
  forSession(input: LaneSessionInput): Promise<LaneSession>;
}

export interface LaneSandboxDeps {
  readonly home: string;
  readonly dataDir: string;
  readonly loginConfigDir: string | null;
  /** Where temp dirs are made; tests pass a short temp root. */
  readonly tmpRoot?: string;
  /** The checkout's git dir and common dir, from `git/`. */
  readonly gitDirs: (
    repoPath: string,
  ) => Promise<{ readonly gitDir: string; readonly commonDir: string }>;
  /** The install prefixes probed for node; tests pass their own. */
  readonly systemPrefixes?: readonly string[];
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

/**
 * Removes a session's env file and temp dir. Both are attempted even when the first fails; the
 * first failure is then thrown.
 */
function removeLaneFiles(envFile: string | null, tmpDir: string, tmpRoot: string): void {
  const removals: (() => void)[] = [
    ...(envFile === null
      ? []
      : [
          () => {
            removeLaneEnvFile(envFile, tmpRoot);
          },
        ]),
    () => {
      removeLaneTempDir(tmpDir, tmpRoot);
    },
  ];
  const failures: Error[] = [];
  for (const remove of removals) {
    try {
      remove();
    } catch (error) {
      failures.push(
        error instanceof Error
          ? error
          : new SandboxTempDirError('Could not remove the lane temp files'),
      );
    }
  }
  const [first] = failures;
  if (first !== undefined) throw first;
}

function realCheckoutOf(checkout: string): string {
  try {
    return realpathSync(checkout);
  } catch {
    throw new SandboxProfileError('checkout', "the checkout can't be read");
  }
}

/** The patterns of the stored rules for `toolName` that a sandbox field can carry; others are left out. */
function storedPatterns(
  rules: LaneSessionInput['rules'],
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

/** Claude Code's spelling of an absolute path in a permission rule: `//` stands for the root. */
const ruleScope = (path: string): string => `/${path}`;

/**
 * `<checkout>/.git`, the git dir and the common dir of every registered checkout but `own`. A checkout
 * whose git dirs can't be read now still gets its `.git` denied, and one that is gone is skipped.
 */
async function otherCheckoutsGitState(
  own: string,
  checkouts: readonly string[],
  gitDirs: LaneSandboxDeps['gitDirs'],
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

/** Builds each lane session's sandbox: one profile, one temp dir and one file-tool context. */
export function createLaneSandbox(deps: LaneSandboxDeps): LaneSandbox {
  const tmpRoot = deps.tmpRoot ?? LANE_TEMP_ROOT;
  return {
    async forSession(input) {
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
            input.configDir,
            ...(deps.loginConfigDir === null ? [] : [deps.loginConfigDir]),
          ],
        }),
        ...MISE_SYSTEM_DIRS,
      ];
      const untrustedRoots = [...input.checkouts, tmpRoot].flatMap((path) => {
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
      const secretFiles = [...checkoutSecrets, ...toolchain.secretFiles];
      const hosts = storedPatterns(input.rules, NETWORK_TOOL, isSandboxDomain);
      const readList = storedPatterns(input.rules, 'Read', isSandboxPath);
      const tmpDir = createLaneTempDir(tmpRoot);
      let envFile: string | null = null;
      try {
        // The lane's own global mise config: the builder's global tool versions and nothing else, so
        // neither its `[env]` nor its age key reaches a lane command.
        const miseConfigDir = join(tmpDir, 'mise');
        mkdirSync(miseConfigDir, { mode: 0o700 });
        const miseConfigFile = join(miseConfigDir, 'config.toml');
        writeFileSync(miseConfigFile, laneMiseConfig(deps.home, input.env), {
          mode: 0o600,
        });
        const commandEnv: Record<string, string> = {
          // Inside the lane's temp dir: a cache can hold code a later install runs, so no lane
          // shares one, and it goes with the lane.
          ...packageCacheEnv(join(tmpDir, 'cache')),
          MISE_CONFIG_DIR: miseConfigDir,
          MISE_GLOBAL_CONFIG_FILE: miseConfigFile,
          // mise's system config moves to the lane's dir too, where none exists.
          MISE_SYSTEM_DIR: miseConfigDir,
          MISE_SYSTEM_CONFIG_FILE: join(miseConfigDir, 'system.toml'),
          // An exception to keeping git config variables: the builder's global config can name
          // hooks, credential helpers and includes the sandboxed git would run or read.
          GIT_CONFIG_GLOBAL: '/dev/null',
          // The git a lane runs reads only: a status never refreshes the index it can't write.
          GIT_OPTIONAL_LOCKS: '0',
        };
        // Claude Code strips some of these from a sandboxed command's env; the shell sets every one
        // of them again from this file before each command.
        envFile = createLaneEnvFile(commandEnv, tmpRoot);
        const env: Record<string, string> = {
          ...commandEnv,
          CLAUDE_CODE_TMPDIR: tmpDir,
          CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
          CLAUDE_ENV_FILE: envFile,
        };
        const settings = buildLaneProfile({
          checkout,
          tmpDir,
          home: deps.home,
          protectedReads: protectedList,
          secretFiles: checkoutSecrets,
          toolchainSecrets: toolchain.secretFiles,
          toolchainReads: toolchain.reads,
          allowedDomains: hosts,
          readList,
          // A linked worktree's common dir is read for the git a lane runs, never written.
          // The env file is read to set up each command's shell, in case that happens in the sandbox.
          extraReads: [envFile, ...(linkedWorktree ? [commonDir] : [])],
          extraWrites: [],
          // Only the daemon writes git state, so a lane can't move HEAD or a ref, stage, or plant
          // config, hooks, alternates or attributes: the git dir and the common dir are read-only to
          // it, and so is `<checkout>/.git`, file or directory, wherever the git dir lies, so a gitfile
          // can't be swapped to point elsewhere. Claude Code would otherwise open them with the checkout.
          // Every other registered checkout's are denied too: one nested in this checkout would
          // otherwise be writable here, and the daemon's git trusts a git dir under any of them.
          denyWrites: [...new Set([join(checkout, '.git'), gitDir, commonDir, ...otherGitState])],
          loopback: input.project.sandboxLoopback,
          deniedEnvNames: deniedEnvNames({ ...input.env, ...env }),
        });
        // The config dir and its ancestors stay readable to the file tools, which open the
        // session's own saved tool results there; the guard, the broker and the kernel hold them.
        const deniedToFileTools = protectedList.filter(
          (path) => !isEqualOrUnder(input.configDir, path),
        );
        const claudeProtected = claudeProtectedPaths(checkout);
        const spec: LaneSandboxSpec = {
          settings,
          env,
          disallowedTools: [
            ...deniedToFileTools.flatMap((path) => [
              `Read(${ruleScope(path)})`,
              `Read(${ruleScope(path)}/**)`,
            ]),
            ...secretFiles.map((path) => `Read(${ruleScope(path)})`),
          ],
          askRules: [
            ...claudeProtected.files.flatMap((path) => [
              `Edit(${ruleScope(path)})`,
              `Write(${ruleScope(path)})`,
            ]),
            ...claudeProtected.directories.flatMap((path) => [
              `Edit(${ruleScope(path)}/**)`,
              `Write(${ruleScope(path)}/**)`,
            ]),
          ],
        };
        let providerSessionId = input.resumeProviderSessionId;
        const fileAccess: FileAccessContext = {
          checkout: input.project.repoPath,
          home: deps.home,
          protectedReads: protectedList,
          secretFiles,
          readList,
          configDir: input.configDir,
          get providerSessionId() {
            return providerSessionId;
          },
        };
        const ownEnvFile = envFile;
        let disposed = false;
        return {
          spec,
          fileAccess,
          tmpDir,
          setProviderSession(id) {
            providerSessionId = id;
          },
          dispose() {
            if (disposed) return;
            disposed = true;
            removeLaneFiles(ownEnvFile, tmpDir, tmpRoot);
          },
        };
      } catch (error) {
        try {
          removeLaneFiles(envFile, tmpDir, tmpRoot);
        } catch {
          // The error that stopped the session is the one to report.
        }
        throw error;
      }
    },
  };
}
