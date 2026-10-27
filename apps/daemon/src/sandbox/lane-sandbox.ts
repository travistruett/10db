import type { PermissionRuleDto, ProjectDto } from '@10db/contracts';
import { prepareCommandEnv } from './command-env';
import { deniedEnvNames } from './env-allowlist';
import { createLaneEnvFile, removeLaneEnvFile } from './env-file';
import { claudeProtectedPaths, type FileAccessContext } from './file-access';
import { buildLaneProfile, type LaneSandboxSettings } from './profile';
import { projectAccess, type ProjectAccessDeps } from './project-access';
import { isEqualOrUnder } from './protected-reads';
import { createLaneTempDir, LANE_TEMP_ROOT, removeAll, removeLaneTempDir } from './temp-dir';

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

export interface LaneSandboxDeps extends Omit<ProjectAccessDeps, 'tmpRoot'> {
  /** Where temp dirs are made; tests pass a short temp root. */
  readonly tmpRoot?: string;
}

/** Removes a session's env file and temp dir; see `removeAll`. */
function removeLaneFiles(envFile: string | null, tmpDir: string, tmpRoot: string): void {
  removeAll([
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
  ]);
}

/** Claude Code's spelling of an absolute path in a permission rule: `//` stands for the root. */
const ruleScope = (path: string): string => `/${path}`;

/** Builds each lane session's sandbox: one profile, one temp dir and one file-tool context. */
export function createLaneSandbox(deps: LaneSandboxDeps): LaneSandbox {
  const tmpRoot = deps.tmpRoot ?? LANE_TEMP_ROOT;
  return {
    async forSession(input) {
      const access = await projectAccess(
        { ...deps, tmpRoot },
        {
          project: input.project,
          env: input.env,
          rules: input.rules,
          configDirs: [input.configDir],
          checkouts: input.checkouts,
        },
      );
      const { checkout, toolchain, readList } = access;
      const protectedList = access.protectedReads;
      const secretFiles = [...access.checkoutSecrets, ...toolchain.secretFiles];
      const tmpDir = createLaneTempDir(tmpRoot);
      let envFile: string | null = null;
      try {
        const commandEnv = prepareCommandEnv(tmpDir, deps.home, input.env);
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
          secretFiles: access.checkoutSecrets,
          toolchainSecrets: toolchain.secretFiles,
          toolchainReads: toolchain.reads,
          allowedDomains: access.hosts,
          readList,
          // A linked worktree's common dir is read for the git a lane runs, never written.
          // The env file is read to set up each command's shell, in case that happens in the sandbox.
          extraReads: [envFile, ...access.gitReads],
          // Claude Code opens the checkout for writing itself.
          extraWrites: [],
          // Claude Code would otherwise open the checkout's git state with the checkout, and a
          // project nested in it.
          denyWrites: [...access.gitState, ...access.otherCheckouts],
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
