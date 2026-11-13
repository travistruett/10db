import { spawn } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { isProtected, type PassGitCall } from '../guard';

/** What a command the builder allowed printed, and how it ended. */
export interface BuilderRun {
  readonly exitCode: number;
  /** Its standard output then its standard error, at most `BUILDER_RUN_MAX_CHARS` of each, the end kept. */
  readonly output: string;
}

/** A call the builder allowed that 10db still would not run, and why. */
export interface BuilderRefusal {
  readonly refused: string;
}

/** The most of each stream a run keeps: the end, where git and gh say how it went. */
const BUILDER_RUN_MAX_CHARS = 20_000;

const keepEnd = (text: string): string =>
  text.length <= BUILDER_RUN_MAX_CHARS ? text : text.slice(-BUILDER_RUN_MAX_CHARS);

/** Runs `argv` with no terminal; never throws: a program that can't start is exit code 127. */
function run(
  argv: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>>,
  signal: AbortSignal,
): Promise<BuilderRun> {
  const [program = '', ...args] = argv;
  return new Promise((done) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(program, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], signal });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout = keepEnd(stdout + chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = keepEnd(stderr + chunk);
    });
    child.on('error', (error) => {
      done({ exitCode: 127, output: `${stdout}${stderr}${error.message}\n` });
    });
    child.on('close', (code) => {
      done({ exitCode: code ?? 1, output: `${stdout}${stderr}` });
    });
  });
}

const refused = (why: string): BuilderRefusal => ({ refused: why });

/**
 * The checkout's own git dir: `<checkout>/.git` as a folder of its own, never a link or a `.git`
 * file naming one elsewhere, which a lane can't write in a pass (its git state is kernel-denied).
 */
function ownGitDir(checkout: string): { readonly root: string; readonly gitDir: string } | null {
  try {
    const root = realpathSync.native(checkout);
    const gitDir = join(root, '.git');
    return lstatSync(gitDir).isDirectory() ? { root, gitDir } : null;
  } catch {
    return null;
  }
}

/**
 * Runs a pass's commit, push or merge the builder allowed on a card, as they would in a terminal:
 * their git config and credentials, and the checkout's own hooks, which a lane can't write in a
 * pass. It runs at the checkout's root with `GIT_DIR` and `GIT_WORK_TREE` set to the checkout's own,
 * so no repository a lane made inside it (with its own config and hooks) is the one that runs, and
 * with `core.fsmonitor` off. A push goes only to a remote the checkout lists, and a push of the
 * current branch only when that branch is neither `main` nor `baseBranch`. Prompts are off, and
 * `signal` ends it with its session.
 */
export async function runPassGit(
  call: Extract<PassGitCall, { kind: 'run' }>,
  opts: {
    readonly checkout: string;
    readonly baseBranch: string;
    readonly env: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
  },
): Promise<BuilderRun | BuilderRefusal> {
  const place = ownGitDir(opts.checkout);
  if (place === null)
    return refused(
      "10db runs a pass's commit, push or merge only in a checkout whose .git is its own folder.",
    );
  const env = {
    ...Object.fromEntries(Object.entries(opts.env).filter(([name]) => !name.startsWith('GIT_'))),
    GIT_DIR: place.gitDir,
    GIT_WORK_TREE: place.root,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.fsmonitor',
    GIT_CONFIG_VALUE_0: 'false',
    GIT_TERMINAL_PROMPT: '0',
    GH_PROMPT_DISABLED: '1',
  };
  const git = (...args: string[]) => run(['git', ...args], place.root, env, opts.signal);
  const common = await git('rev-parse', '--git-common-dir');
  const commonDir = common.output.trim();
  const commonReal = (() => {
    try {
      return realpathSync.native(
        isAbsolute(commonDir) ? commonDir : resolve(place.root, commonDir),
      );
    } catch {
      return null;
    }
  })();
  if (common.exitCode !== 0 || commonReal !== place.gitDir)
    return refused(
      "This checkout's git dir shares its history with another one, so 10db won't run it.",
    );
  if (call.push !== null) {
    const remotes = await git('remote');
    const listed = remotes.output.split('\n').map((line) => line.trim());
    if (remotes.exitCode !== 0 || !listed.includes(call.push.remote))
      return refused(
        `${call.push.remote} is no remote this checkout lists, so 10db won't push there. Push to one \`git remote\` lists, such as origin.`,
      );
    if (call.push.currentBranch) {
      const head = await git('symbolic-ref', '--short', '-q', 'HEAD');
      const branch = head.exitCode === 0 ? head.output.trim() : '';
      if (branch === '' || isProtected(branch, opts.baseBranch))
        return refused(
          `This push sends the current branch, ${branch === '' ? 'a detached HEAD' : branch}, and a push of ${branch === '' ? 'it' : branch} stays refused in a pass: 10db lands the work on main and the base branch when it ships. Push a branch of your own by name.`,
        );
    }
  }
  return run(call.argv, place.root, env, opts.signal);
}
