import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PermissionRuleDto, ProjectDto } from '@10db/contracts';
import type { Logger } from '../log';
import {
  DOCKER_REFUSAL,
  SandboxProfileError,
  SandboxTempDirError,
  type GateRun,
  type GateSandbox,
} from '../sandbox';

export interface GateResult {
  readonly exitCode: number;
  readonly durationMs: number;
  readonly tail: string;
  readonly logPath: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;
}

export interface GateRequest {
  readonly project: Pick<ProjectDto, 'repoPath' | 'sandboxLoopback'>;
  readonly command: string;
  readonly logPath: string;
  readonly timeoutMs: number;
  /** The project env; under the sandbox only its allowlisted names reach the command. */
  readonly env: Readonly<Record<string, string>>;
  /** The project's stored rules: the hosts and read paths the sandbox opens, as for its lanes. */
  readonly rules: readonly Pick<PermissionRuleDto, 'toolName' | 'pattern'>[];
  /** Every registered checkout, whose git state the gate can't write. */
  readonly checkouts: readonly string[];
  /** Aborting kills the whole process group (stop and cancel use this). */
  readonly signal?: AbortSignal;
  /** Receives the process-group leader's pid as soon as it exists. */
  readonly onSpawn?: (pid: number) => void;
  /**
   * Called when the gate has to wait for another gate to finish before it starts, with the number of
   * gates ahead of it. Never called for a gate that starts at once.
   */
  readonly onWaiting?: (ahead: number) => void;
}

export interface GateRunner {
  run(request: GateRequest): Promise<GateResult>;
}

export interface GateRunnerOptions {
  /**
   * Every real gate runs under it: the gate runs code a lane wrote. Only tests whose gate commands
   * need no sandbox pass null, as they pass a null lane sandbox.
   */
  readonly sandbox: GateSandbox | null;
  readonly logger: Logger;
}

const TAIL_BYTES = 4096;
const TIMEOUT_EXIT = 124;
const ABORT_EXIT = 130;
/** The exit code of a gate whose sandbox could not start, as a shell reports a command it can't run. */
const UNSTARTED_EXIT = 126;

/** What to spawn: the gate's sandbox, or with none, the command itself. */
interface Spawnable {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
}

function unsandboxed(request: GateRequest): Spawnable {
  return {
    file: '/bin/sh',
    args: ['-c', request.command],
    env: request.env,
    cwd: request.project.repoPath,
  };
}

/** A gate that never ran: its log and tail say why. */
function unstarted(logPath: string, message: string): GateResult {
  const text = `${message}\n`;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, text);
  } catch {
    // The tail still carries the reason.
  }
  return {
    exitCode: UNSTARTED_EXIT,
    durationMs: 0,
    tail: text,
    logPath,
    timedOut: false,
    aborted: false,
  };
}

/** Runs one spawnable in its own process group, logging its output, until it exits. */
function runGroup(
  target: Spawnable,
  request: GateRequest,
  sandboxed: GateRun | null,
): Promise<GateResult> {
  const { logPath, timeoutMs, signal, onSpawn } = request;
  mkdirSync(dirname(logPath), { recursive: true });
  const log = createWriteStream(logPath);
  const started = performance.now();
  let tail = '';
  let timedOut = false;
  let aborted = false;
  const child = spawn(target.file, [...target.args], {
    cwd: target.cwd,
    env: target.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // A log that cannot be written must not take the daemon down; the gate still runs and reports its tail.
  log.on('error', () => undefined);
  const onData = (chunk: Buffer | string): void => {
    log.write(chunk);
    tail = (tail + chunk.toString()).slice(-TAIL_BYTES);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const killGroup = (): void => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    } catch {
      // ESRCH: the group already exited. Throwing here would be an uncaught exception in a timer.
    }
  };
  // A real timer on purpose: it bounds a real child process, so the injected clock does not apply.
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup();
  }, timeoutMs);
  const onAbort = (): void => {
    aborted = true;
    killGroup();
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const endLog = (done: () => void): void => {
    if (log.destroyed) done();
    else log.end(done);
  };
  return new Promise<GateResult>((resolve, reject) => {
    child.on('error', (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      endLog(() => {
        reject(error);
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      // Whatever the gate left running in its group must not outlive its verdict.
      killGroup();
      // Said last, so the evidence keeps it however much the gate printed before.
      if (sandboxed?.dockerRefused()) onData(`\n${DOCKER_REFUSAL}\n`);
      endLog(() => {
        resolve({
          // A gate that died by a signal has no code, and fails.
          exitCode: timedOut ? TIMEOUT_EXIT : aborted ? ABORT_EXIT : (code ?? 1),
          durationMs: Math.round(performance.now() - started),
          tail,
          logPath,
          timedOut,
          aborted,
        });
      });
    });
    if (child.pid !== undefined && onSpawn) {
      try {
        onSpawn(child.pid);
      } catch (error) {
        // The caller could not record the group, so nothing may keep running unobserved.
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        killGroup();
        // The log may still be opening; a caller that removes its directory next must not race it.
        endLog(() => {
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      }
    }
  });
}

/** Runs the project's gate command itself, because "done" means the gate passed. */
export function createGateRunner(options: GateRunnerOptions): GateRunner {
  return {
    async run(request) {
      if (options.sandbox === null) return runGroup(unsandboxed(request), request, null);
      let sandboxed: GateRun;
      try {
        sandboxed = await options.sandbox.forRun({
          project: request.project,
          env: request.env,
          rules: request.rules,
          checkouts: request.checkouts,
          command: request.command,
        });
      } catch (error) {
        if (error instanceof SandboxProfileError || error instanceof SandboxTempDirError)
          return unstarted(
            request.logPath,
            `10db could not start the gate's sandbox: ${error.message}`,
          );
        throw error;
      }
      try {
        return await runGroup(sandboxed, request, sandboxed);
      } finally {
        try {
          await sandboxed.dispose();
        } catch (error) {
          options.logger.warn(
            { err: error instanceof Error ? error.message : String(error) },
            "the gate's temp dir could not be removed",
          );
        }
      }
    },
  };
}
