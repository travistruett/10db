import {
  ConflictError,
  UpstreamError,
  type GithubLoginEndedData,
  type GithubSigninDto,
} from '@10db/contracts';
import type { Clock, Timer } from '../clock';
import { loginFailureMessage, parseDeviceLogin } from './login-text';

/** How long gh has to print the one-time code after it starts. */
export const CODE_WAIT_MS = 5_000;
/** How long the builder has to approve in the browser, from the moment the code is shown. */
export const SIGN_IN_WAIT_MS = 10 * 60_000;
/** How long a stopped gh gets to exit before it is killed outright. */
export const KILL_GRACE_MS = 2_000;

/** A running `gh auth login`: its output on either stream, its end and a way to stop it. */
export interface GhLoginChild {
  onOutput(listener: (stream: 'stdout' | 'stderr', chunk: string) => void): void;
  /** `code` is null when gh was killed or could not start. */
  onExit(listener: (code: number | null) => void): void;
  kill(signal: NodeJS.Signals): void;
}

export type GhLoginSpawn = (gh: string, env: Readonly<Record<string, string>>) => GhLoginChild;

export interface GithubLoginDeps {
  readonly clock: Clock;
  readonly spawn: GhLoginSpawn;
  /** The gh to run, looked up again on every start. */
  readonly resolveGh: () => string | null;
  /** The login environment gh runs in. */
  readonly env: () => Readonly<Record<string, string>>;
  /** Re-reads gh's login and records it, so a status read after the end already shows it. */
  readonly readLogin: () => Promise<string | null>;
  /** Announces how a sign-in ended; never called for a daemon stop or a start that never showed a code. */
  readonly ended: (data: GithubLoginEndedData) => void;
}

export interface WaitingSignIn extends GithubSigninDto {
  readonly startedAt: string;
}

export interface GithubLogin {
  /** Starts a sign-in and answers once gh has printed the code and page. */
  start(): Promise<WaitingSignIn>;
  /** Stops the running sign-in, if any. */
  cancel(): void;
  /** The sign-in waiting for the builder, or null. */
  current(): WaitingSignIn | null;
  /** Stops gh when the daemon stops. */
  stop(): void;
}

interface Run {
  readonly child: GhLoginChild;
  /** Set once the run has ended any way; later events from gh or a timer change nothing. */
  over: boolean;
  exited: boolean;
  readonly lines: string[];
  readonly stderrLines: string[];
  readonly tails: { stdout: string; stderr: string };
  waiting: WaitingSignIn | null;
  timer: Timer | null;
  /** Settles the pending POST; null once it has been answered. */
  answer: {
    readonly resolve: (value: WaitingSignIn) => void;
    readonly reject: (error: Error) => void;
  } | null;
}

/**
 * Runs `gh auth login --web` for the builder, one at a time. The slot is taken when gh spawns
 * (`starting`), the POST answers when gh prints its code (`waiting`), and the slot is free again when
 * gh exits, the builder cancels, ten minutes pass or the daemon stops. Time is the injected clock.
 */
export function createGithubLogin(deps: GithubLoginDeps): GithubLogin {
  let run: Run | null = null;

  function stopChild(r: Run): void {
    if (r.exited) return;
    r.child.kill('SIGTERM');
    const grace = deps.clock.setTimeout(() => {
      if (!r.exited) r.child.kill('SIGKILL');
    }, KILL_GRACE_MS);
    r.child.onExit(() => {
      grace.cancel();
    });
  }

  /** Ends the run: nothing more is read from gh or timers, and gh is stopped. */
  function close(r: Run): void {
    r.over = true;
    r.timer?.cancel();
    r.timer = null;
    stopChild(r);
  }

  function release(r: Run): void {
    if (run === r) run = null;
  }

  function startDeadline(r: Run): void {
    r.timer = deps.clock.setTimeout(() => {
      if (r.over) return;
      close(r);
      if (r.answer) {
        const { reject } = r.answer;
        r.answer = null;
        release(r);
        reject(new UpstreamError("gh didn't print a code"));
        return;
      }
      end(r, { ok: false, login: null, message: 'Sign-in timed out', cancelled: false });
    }, CODE_WAIT_MS);
  }

  function end(r: Run, data: GithubLoginEndedData): void {
    release(r);
    deps.ended(data);
  }

  function readOutput(r: Run, stream: 'stdout' | 'stderr', chunk: string): void {
    if (r.over) return;
    const text = r.tails[stream] + chunk;
    const parts = text.split(/\r?\n/);
    r.tails[stream] = parts.pop() ?? '';
    for (const line of parts) {
      r.lines.push(line);
      if (stream === 'stderr') r.stderrLines.push(line);
    }
    if (r.waiting !== null || r.answer === null) return;
    const found = parseDeviceLogin(r.lines);
    if (found === null) return;
    r.waiting = { ...found, startedAt: deps.clock.now().toISOString() };
    r.timer?.cancel();
    r.timer = deps.clock.setTimeout(() => {
      if (r.over) return;
      close(r);
      end(r, { ok: false, login: null, message: 'Sign-in timed out', cancelled: false });
    }, SIGN_IN_WAIT_MS);
    const { resolve } = r.answer;
    r.answer = null;
    resolve(r.waiting);
  }

  async function readExit(r: Run, code: number | null): Promise<void> {
    r.exited = true;
    if (r.over) return;
    r.over = true;
    r.timer?.cancel();
    r.timer = null;
    const pending = r.answer;
    r.answer = null;
    if (code === 0) {
      const login = await deps.readLogin().catch(() => null);
      if (pending) {
        release(r);
        pending.reject(new ConflictError('Already signed in'));
        return;
      }
      end(r, { ok: true, login, message: null, cancelled: false });
      return;
    }
    const message = loginFailureMessage(r.stderrLines);
    if (pending) {
      release(r);
      pending.reject(new UpstreamError(message));
      return;
    }
    end(r, { ok: false, login: null, message, cancelled: false });
  }

  return {
    start() {
      if (run !== null) return Promise.reject(new ConflictError('A sign-in is already running'));
      const gh = deps.resolveGh();
      if (gh === null)
        return Promise.reject(
          new ConflictError(
            "gh isn't installed. Install the GitHub CLI (brew install gh), then Check Again.",
          ),
        );
      let child: GhLoginChild;
      try {
        child = deps.spawn(gh, deps.env());
      } catch {
        return Promise.reject(new UpstreamError("10db couldn't start gh"));
      }
      return new Promise<WaitingSignIn>((resolve, reject) => {
        const r: Run = {
          child,
          over: false,
          exited: false,
          lines: [],
          stderrLines: [],
          tails: { stdout: '', stderr: '' },
          waiting: null,
          timer: null,
          answer: { resolve, reject },
        };
        run = r;
        child.onOutput((stream, chunk) => {
          readOutput(r, stream, chunk);
        });
        child.onExit((code) => {
          void readExit(r, code);
        });
        startDeadline(r);
      });
    },
    cancel() {
      const r = run;
      if (r === null || r.over) return;
      close(r);
      if (r.answer) {
        const { reject } = r.answer;
        r.answer = null;
        release(r);
        reject(new ConflictError('Cancelled'));
        return;
      }
      end(r, { ok: false, login: null, message: 'Sign-in cancelled.', cancelled: true });
    },
    current: () => (run !== null && !run.over ? run.waiting : null),
    stop() {
      const r = run;
      if (r === null || r.over) return;
      close(r);
      release(r);
      if (r.answer) {
        const { reject } = r.answer;
        r.answer = null;
        reject(new ConflictError('10db is stopping'));
      }
    },
  };
}
