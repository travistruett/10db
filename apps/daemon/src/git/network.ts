import { spawn } from 'node:child_process';
import { daemonGitArgs } from './daemon-config';
import { redactUrls } from './remote-url';
import { networkGitEnv } from './run';

/** How a network call is made: in the login environment, bounded in time, stoppable. */
export interface NetworkCall {
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export const GitNetworkFailure = {
  Timeout: 'timeout',
  Rejected: 'rejected',
  Aborted: 'aborted',
  Failed: 'failed',
} as const;
export type GitNetworkFailure = (typeof GitNetworkFailure)[keyof typeof GitNetworkFailure];

/** What a fetch or push did: how long git ran, and the end of what it printed. */
export interface NetworkRun {
  readonly durationMs: number;
  readonly output: string;
}

/** A fetch or push that did not complete; `detail` is git's own message, trimmed. */
export class GitNetworkError extends Error {
  override readonly name = 'GitNetworkError';
  readonly kind: GitNetworkFailure;
  readonly detail: string;
  readonly durationMs: number;
  readonly output: string;
  /** Every URL in it, the command's own included, has its userinfo masked, so no token reaches a log or card. */
  constructor(kind: GitNetworkFailure, args: readonly string[], detail: string, run: NetworkRun) {
    super(redactUrls(`git ${args.join(' ')}: ${kind}${detail ? `: ${detail}` : ''}`));
    this.kind = kind;
    this.detail = redactUrls(detail);
    this.durationMs = run.durationMs;
    this.output = redactUrls(run.output);
  }
}

const REJECTED = /\[(remote )?rejected\]|failed to push some refs/i;
/** How much of git's output a run keeps: the end, where git says what went wrong. */
const OUTPUT_TAIL = 2000;
/** How much it reads before redacting; a line cut at the front of this is dropped whole. */
const RAW_TAIL = 64 * 1024;

/** A rolling tail of text that is redacted whole before it is cut to `OUTPUT_TAIL`. */
function tailBuffer() {
  let text = '';
  let cut = false;
  return {
    add(chunk: string): void {
      text += chunk;
      if (text.length > RAW_TAIL) {
        text = text.slice(-RAW_TAIL);
        cut = true;
      }
    },
    /** The redacted end; a first line that was cut part-way, which could hold half a URL, is dropped. */
    read(): string {
      const whole = cut ? text.slice(text.indexOf('\n') + 1) : text;
      return redactUrls(whole).slice(-OUTPUT_TAIL).trim();
    },
  };
}

/**
 * Runs a fetch or push in a process group of its own, with `config` (`-c` arguments) before
 * `DAEMON_GIT_CONFIG`'s. A transport such as ssh may hang or start children of its own; a timeout
 * or an abort kills the group, so nothing git started outlives it, and the call settles only once
 * git has exited.
 */
export function gitNetwork(
  repo: string,
  config: readonly string[],
  args: readonly string[],
  net: NetworkCall,
  at: { readonly bin: string; readonly env: Readonly<Record<string, string>> },
): Promise<NetworkRun> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(at.bin, ['-C', repo, ...config, ...daemonGitArgs(), ...args], {
      env: networkGitEnv(net.env, at.env),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stderr = tailBuffer();
    const output = tailBuffer();
    let timedOut = false;
    const elapsed = (): number => Math.round(performance.now() - started);
    child.stdout.on('data', (chunk: Buffer) => {
      output.add(chunk.toString('utf8'));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderr.add(text);
      output.add(text);
    });
    const killGroup = (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // ESRCH: the group already exited.
      }
    };
    // A real timer on purpose: it bounds a real child process, so the injected clock does not apply.
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, net.timeoutMs);
    if (net.signal?.aborted) killGroup();
    else net.signal?.addEventListener('abort', killGroup, { once: true });
    const settle = (): void => {
      clearTimeout(timer);
      net.signal?.removeEventListener('abort', killGroup);
    };
    child.on('error', (error) => {
      settle();
      reject(
        new GitNetworkError(GitNetworkFailure.Failed, args, error.message, {
          durationMs: elapsed(),
          output: output.read(),
        }),
      );
    });
    child.on('close', (code) => {
      settle();
      const detail = stderr.read();
      const run: NetworkRun = { durationMs: elapsed(), output: output.read() };
      if (net.signal?.aborted)
        reject(new GitNetworkError(GitNetworkFailure.Aborted, args, '', run));
      else if (timedOut)
        reject(
          new GitNetworkError(
            GitNetworkFailure.Timeout,
            args,
            `still running after ${String(Math.round(net.timeoutMs / 1000))} s; stopped with every process it started`,
            run,
          ),
        );
      else if (code === 0) resolve(run);
      else
        reject(
          new GitNetworkError(
            REJECTED.test(detail) ? GitNetworkFailure.Rejected : GitNetworkFailure.Failed,
            args,
            detail,
            run,
          ),
        );
    });
  });
}
