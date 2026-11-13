import { spawn } from 'node:child_process';

/** What a command the builder allowed printed, and how it ended. */
export interface BuilderRun {
  readonly exitCode: number;
  /** Its standard output then its standard error, at most `BUILDER_RUN_MAX_CHARS` of each, the end kept. */
  readonly output: string;
}

/** The most of each stream a run keeps: the end, where git and gh say how it went. */
const BUILDER_RUN_MAX_CHARS = 20_000;

const keepEnd = (text: string): string =>
  text.length <= BUILDER_RUN_MAX_CHARS ? text : text.slice(-BUILDER_RUN_MAX_CHARS);

/**
 * Runs a git or gh call the builder allowed on a card, as they would run it in a terminal: in `cwd`,
 * with `env`, outside every sandbox, so their credentials and the repository's hooks take part. It
 * reads nothing from a terminal (prompts are off), and `signal` ends it with its session. Never
 * throws: a program that can't start is exit code 127 with the reason.
 */
export function runAsBuilder(
  argv: readonly string[],
  opts: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
  },
): Promise<BuilderRun> {
  const [program = '', ...args] = argv;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(program, args, {
      cwd: opts.cwd,
      env: { ...opts.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: opts.signal,
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout = keepEnd(stdout + chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = keepEnd(stderr + chunk);
    });
    child.on('error', (error) => {
      resolve({ exitCode: 127, output: `${stdout}${stderr}${error.message}\n` });
    });
    child.on('close', (code) => {
      resolve({ exitCode: code ?? 1, output: `${stdout}${stderr}` });
    });
  });
}
