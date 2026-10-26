import { readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { PermissionRuleDto, ProjectDto } from '@10db/contracts';
import { deniedEnvNames } from './env-allowlist';
import { claudeProtectedPaths, type FileAccessContext } from './file-access';
import { packageCacheEnv, projectCacheDir } from './package-cache';
import {
  buildLaneProfile,
  isSandboxDomain,
  isSandboxPath,
  SandboxProfileError,
  type LaneSandboxSettings,
} from './profile';
import { isEqualOrUnder, protectedReads } from './protected-reads';
import { createLaneTempDir, LANE_TEMP_ROOT, removeLaneTempDir } from './temp-dir';
import { toolchainReads } from './toolchain-reads';

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
  readonly project: Pick<ProjectDto, 'id' | 'repoPath'>;
  /** The session's launch env, before the sandbox's own is merged over it. */
  readonly env: Readonly<Record<string, string>>;
  /** The project's and the workstream's stored permission rules. */
  readonly rules: readonly Pick<PermissionRuleDto, 'toolName' | 'pattern'>[];
  readonly resumeProviderSessionId: string | null;
  /** The config dir of the account the session runs on, where Claude Code saves its tool results. */
  readonly configDir: string;
}

export interface LaneSandbox {
  forSession(input: LaneSessionInput): Promise<LaneSession>;
}

export interface LaneSandboxDeps {
  readonly home: string;
  readonly dataDir: string;
  readonly loopback: boolean;
  readonly loginConfigDir: string | null;
  /** Where temp dirs are made; tests pass a short temp root. */
  readonly tmpRoot?: string;
  /** The checkout's git dir and common dir, from `git/`. */
  readonly gitDirs: (
    repoPath: string,
  ) => Promise<{ readonly gitDir: string; readonly commonDir: string }>;
}

const NETWORK_TOOL = 'SandboxNetworkAccess';
const SECRET_FILE_PREFIX = '.env';
const UNWALKED_DIRECTORIES: ReadonlySet<string> = new Set(['node_modules', '.git']);

/** Every `.env*` file, or link, under `root`, by real path; directories in `UNWALKED_DIRECTORIES` and links are not entered. */
function secretFilesIn(root: string): string[] {
  const found: string[] = [];
  const pending = [root];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // A directory that can't be listed could hide a secret file the profile must name.
      throw new SandboxProfileError('secretFiles', 'unreadable');
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!UNWALKED_DIRECTORIES.has(entry.name)) pending.push(path);
      } else if (entry.name.startsWith(SECRET_FILE_PREFIX)) {
        found.push(path);
      }
    }
  }
  return found.sort();
}

function realCheckoutOf(checkout: string): string {
  try {
    return realpathSync(checkout);
  } catch {
    throw new SandboxProfileError('checkout', 'unreadable');
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

/** Builds each lane session's sandbox: one profile, one temp dir and one file-tool context. */
export function createLaneSandbox(deps: LaneSandboxDeps): LaneSandbox {
  const tmpRoot = deps.tmpRoot ?? LANE_TEMP_ROOT;
  return {
    async forSession(input) {
      const checkout = realCheckoutOf(input.project.repoPath);
      const secretFiles = secretFilesIn(checkout);
      const { gitDir, commonDir } = await deps.gitDirs(checkout);
      const linkedWorktree = !isEqualOrUnder(commonDir, checkout);
      const protectedList = protectedReads({
        home: deps.home,
        dataDir: deps.dataDir,
        configDirs: [
          input.configDir,
          ...(deps.loginConfigDir === null ? [] : [deps.loginConfigDir]),
        ],
      });
      const hosts = storedPatterns(input.rules, NETWORK_TOOL, isSandboxDomain);
      const readList = storedPatterns(input.rules, 'Read', isSandboxPath);
      const cacheDir = projectCacheDir(deps.home, input.project.id);
      const tmpDir = createLaneTempDir(tmpRoot);
      try {
        const env: Record<string, string> = {
          ...packageCacheEnv(cacheDir),
          CLAUDE_CODE_TMPDIR: tmpDir,
          // An exception to keeping git config variables: the builder's global config can name
          // hooks, credential helpers and includes the sandboxed git would run or read.
          GIT_CONFIG_GLOBAL: '/dev/null',
          CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
        };
        const settings = buildLaneProfile({
          checkout,
          tmpDir,
          home: deps.home,
          protectedReads: protectedList,
          secretFiles,
          toolchainReads: toolchainReads(deps.home, input.env['PATH'] ?? ''),
          packageCacheDir: cacheDir,
          allowedDomains: hosts,
          readList,
          extraReads: linkedWorktree ? [commonDir] : [],
          extraWrites: linkedWorktree ? [gitDir] : [],
          loopback: deps.loopback,
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
          readList,
          configDir: input.configDir,
          get providerSessionId() {
            return providerSessionId;
          },
        };
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
            removeLaneTempDir(tmpDir, tmpRoot);
          },
        };
      } catch (error) {
        try {
          removeLaneTempDir(tmpDir, tmpRoot);
        } catch {
          // The error that stopped the session is the one to report.
        }
        throw error;
      }
    },
  };
}
