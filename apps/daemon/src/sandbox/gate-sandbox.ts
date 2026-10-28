import { chmodSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PermissionRuleDto, ProjectDto } from '@10db/contracts';
import { prepareCommandEnv } from './command-env';
import { shellAssignments } from './env-file';
import { singleQuoted } from './posix-quote';
import { buildLaneProfile } from './profile';
import { projectAccess, projectWritableRoots, type ProjectAccessDeps } from './project-access';
import { createSealedFile, removeSealedFile, type SealedFileKind } from './sealed-file';
import {
  allowlisted,
  checkRuntime,
  HOST_PATH,
  SRT_SHARED_TEMP,
  type SandboxRuntime,
} from './srt-launch';
import { srtSettings } from './srt-settings';
import {
  createLaneTempDir,
  LANE_TEMP_ROOT,
  removeLaneTempDirAsync,
  SandboxTempDirError,
} from './temp-dir';

/** What the `docker` on a sandboxed gate's PATH says. */
export const DOCKER_REFUSAL =
  "10db: Docker isn't available to sandboxed gates: a gate never gets the Docker socket.";

const SETTINGS_FILE: SealedFileKind = {
  prefix: '10db-gate-',
  suffix: '.json',
  what: 'the gate sandbox settings file',
};
const DOCKER_MARKER = 'docker-refused';

export interface GateRunInput {
  readonly project: Pick<ProjectDto, 'repoPath' | 'sandboxLoopback'>;
  /** The project env (the login env without billing switches); only allowlisted names reach the gate. */
  readonly env: Readonly<Record<string, string>>;
  /** The project's stored permission rules: their hosts and read paths open as they do for lanes. */
  readonly rules: readonly Pick<PermissionRuleDto, 'toolName' | 'pattern'>[];
  /** Every project's checkout: their git state stays read-only, and their PATH entries are dropped. */
  readonly checkouts: readonly string[];
  /** The gate command, which `/bin/sh -c` runs inside the sandbox. */
  readonly command: string;
}

/** One gate run under the sandbox: the process to spawn, and its own temp dir. */
export interface GateRun {
  /** srt's host, which starts the network proxy and runs the command under the profile. */
  readonly file: string;
  readonly args: readonly string[];
  /** The host's env: a fixed PATH, HOME and srt's temp dir. */
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly tmpDir: string;
  /** The env the gate command runs with, set inside the sandbox. */
  readonly commandEnv: Readonly<Record<string, string>>;
  /** True once the command has run `docker`, which no sandboxed gate can use. */
  dockerRefused(): boolean;
  /**
   * Removes the temp dir and the settings file, off the event loop. Run it once the gate's process
   * group is gone.
   */
  dispose(): Promise<void>;
}

export interface GateSandbox {
  forRun(input: GateRunInput): Promise<GateRun>;
}

export interface GateSandboxDeps extends Omit<ProjectAccessDeps, 'tmpRoot'> {
  /** Where temp dirs are made; tests pass a short temp root. */
  readonly tmpRoot?: string;
  readonly runtime: SandboxRuntime;
}

/** A `docker` that refuses, first on the gate's PATH, and records that the gate asked for it. */
function writeDockerShim(binDir: string, marker: string): void {
  mkdirSync(binDir, { mode: 0o700 });
  const shim = join(binDir, 'docker');
  writeFileSync(
    shim,
    `#!/bin/sh\nprintf '%s\\n' ${singleQuoted(DOCKER_REFUSAL)} >&2\n: > ${singleQuoted(marker)}\nexit 125\n`,
  );
  chmodSync(shim, 0o755);
}

/**
 * Builds each gate run's sandbox from the lane profile: the same reads, protected reads, secret
 * files, git state and hosts, with the checkout and the run's own temp dir writable. The command
 * runs under srt (`@anthropic-ai/sandbox-runtime`, Seatbelt on macOS) with the allowlisted env, set
 * inside the sandbox, so nothing outside it acts on what the gate's env or PATH name.
 */
export function createGateSandbox(deps: GateSandboxDeps): GateSandbox {
  const tmpRoot = deps.tmpRoot ?? LANE_TEMP_ROOT;
  return {
    async forRun(input) {
      checkRuntime(deps.runtime, projectWritableRoots(input.checkouts, tmpRoot));
      const access = await projectAccess(
        { ...deps, tmpRoot },
        {
          project: input.project,
          env: input.env,
          rules: input.rules,
          configDirs: [],
          checkouts: input.checkouts,
        },
      );
      const { checkout, toolchain } = access;
      const tmpDir = createLaneTempDir(tmpRoot);
      let settingsFile: string | null = null;
      // Both are removed even when one fails; the first failure is then thrown.
      const remove = async (): Promise<void> => {
        const failures: Error[] = [];
        const record = (error: unknown): void => {
          failures.push(
            error instanceof Error
              ? error
              : new SandboxTempDirError("Could not remove the gate's sandbox files"),
          );
        };
        if (settingsFile !== null) {
          try {
            removeSealedFile(settingsFile, tmpRoot, SETTINGS_FILE);
          } catch (error) {
            record(error);
          }
        }
        await removeLaneTempDirAsync(tmpDir, tmpRoot).catch(record);
        const [first] = failures;
        if (first !== undefined) throw first;
      };
      try {
        const binDir = join(tmpDir, 'bin');
        const marker = join(tmpDir, DOCKER_MARKER);
        writeDockerShim(binDir, marker);
        const commandEnv: Record<string, string> = {
          ...allowlisted(input.env),
          TMPDIR: tmpDir,
          ...prepareCommandEnv(tmpDir, deps.home, input.env),
          PATH: [binDir, ...(input.env['PATH'] ? [input.env['PATH']] : [])].join(':'),
        };
        const profile = buildLaneProfile({
          checkout,
          tmpDir,
          home: deps.home,
          protectedReads: access.protectedReads,
          secretFiles: access.checkoutSecrets,
          toolchainSecrets: toolchain.secretFiles,
          toolchainReads: toolchain.reads,
          allowedDomains: access.hosts,
          readList: access.readList,
          extraReads: access.gitReads,
          // srt opens nothing for writing by itself, unlike Claude Code, which opens the checkout.
          extraWrites: [checkout],
          denyWrites: [...access.gitState, ...access.otherCheckouts, ...SRT_SHARED_TEMP],
          loopback: input.project.sandboxLoopback,
          deniedEnvNames: [],
        });
        // Set inside the sandbox, after srt's own variables: `env` there replaces PATH and drops
        // the host's temp variable, and the command never sees the host's env otherwise. srt exits
        // 0 when its own child dies by TERM or INT, so the command is never that child: the shell
        // srt starts waits for it and exits with a status, and its traps turn a TERM or INT it is
        // sent itself (from the gate's own group or from srt) into a failing one.
        const inner = [
          "trap 'exit 143' TERM; trap 'exit 130' INT;",
          '/usr/bin/env -u CLAUDE_CODE_TMPDIR',
          ...shellAssignments(commandEnv),
          '/bin/sh -c',
          singleQuoted(input.command),
          '; exit $?',
        ].join(' ');
        settingsFile = createSealedFile(
          tmpRoot,
          SETTINGS_FILE,
          JSON.stringify(srtSettings(profile), null, 2),
        );
        let disposed: Promise<void> | null = null;
        return {
          file: deps.runtime.node,
          args: [deps.runtime.cli, '--settings', settingsFile, '-c', inner],
          env: { PATH: HOST_PATH, HOME: deps.home, CLAUDE_CODE_TMPDIR: tmpDir },
          cwd: checkout,
          tmpDir,
          commandEnv,
          dockerRefused() {
            try {
              // The gate can write its temp dir, so the marker is only looked at, never followed.
              return lstatSync(marker).isFile();
            } catch {
              return false;
            }
          },
          dispose() {
            disposed ??= remove();
            return disposed;
          },
        };
      } catch (error) {
        // The error that stopped the run is the one to report.
        await remove().catch(() => undefined);
        throw error;
      }
    },
  };
}
