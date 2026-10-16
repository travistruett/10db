import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface GateResult {
  readonly exitCode: number;
  readonly durationMs: number;
  readonly tail: string;
  readonly logPath: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;
}

export interface GateRunner {
  run(input: {
    readonly repo: string;
    readonly command: string;
    readonly logPath: string;
    readonly timeoutMs: number;
    readonly env: Readonly<Record<string, string | undefined>>;
    /** Aborting kills the whole process group (stop and cancel use this). */
    readonly signal?: AbortSignal;
    /** Receives the process-group leader's pid as soon as it exists. */
    readonly onSpawn?: (pid: number) => void;
  }): Promise<GateResult>;
}

const TAIL_BYTES = 4096;
const TIMEOUT_EXIT = 124;
const ABORT_EXIT = 130;

/** Runs the project's gate command itself, because "done" means the gate passed. */
export function createGateRunner(): GateRunner {
  return {
    run({ repo, command, logPath, timeoutMs, env, signal, onSpawn }) {
      mkdirSync(dirname(logPath), { recursive: true });
      const log = createWriteStream(logPath);
      const started = performance.now();
      let tail = '';
      let timedOut = false;
      let aborted = false;
      const child = spawn('/bin/sh', ['-c', command], {
        cwd: repo,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      // A log that cannot be written must not take the daemon down; the gate still runs and reports its tail.
      log.on('error', () => undefined);
      const onData = (chunk: Buffer): void => {
        log.write(chunk);
        tail = (tail + chunk.toString('utf8')).slice(-TAIL_BYTES);
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
          endLog(() => {
            resolve({
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
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        }
      });
    },
  };
}
