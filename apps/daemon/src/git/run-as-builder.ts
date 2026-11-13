import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { systemClock, type Clock } from '../clock';
import { SECRET_VARIABLES } from '../environment';
import { isProtected, type PassGitCall } from '../guard';
import { singleQuoted, type GateRunInput, type GateSandbox } from '../sandbox';
import { NO_ATTRIBUTES_CONFIG } from './git';
import { shellWord } from './shell-word';

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

/** How long a call the builder allowed may run before 10db stops it and what it started. */
const BUILDER_RUN_TIMEOUT_MS = 10 * 60_000;

/** The exit code of a call 10db stopped, at its deadline or with its session, as `timeout` gives. */
const STOPPED_EXIT_CODE = 124;

/**
 * Runs `argv` with no terminal in a process group of its own; never throws: a program that can't
 * start is exit code 127. At `BUILDER_RUN_TIMEOUT_MS`, or when `signal` ends it, the whole group is
 * killed, so nothing a hook or a transport started outlives it.
 */
function run(
  argv: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>>,
  signal: AbortSignal,
  clock: Clock,
): Promise<BuilderRun> {
  const [program = '', ...args] = argv;
  return new Promise((done) => {
    if (signal.aborted) {
      done({ exitCode: STOPPED_EXIT_CODE, output: '10db stopped it: its session ended.\n' });
      return;
    }
    let stdout = '';
    let stderr = '';
    let stopped: string | null = null;
    const child = spawn(program, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const stop = (why: string): void => {
      stopped ??= why;
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The group is gone already.
      }
    };
    const onAbort = (): void => {
      stop('10db stopped it: its session ended.');
    };
    signal.addEventListener('abort', onAbort, { once: true });
    const deadline = clock.setTimeout(() => {
      stop(`10db stopped it after ${String(BUILDER_RUN_TIMEOUT_MS / 60_000)} minutes.`);
    }, BUILDER_RUN_TIMEOUT_MS);
    const finish = (result: BuilderRun): void => {
      deadline.cancel();
      signal.removeEventListener('abort', onAbort);
      done(result);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout = keepEnd(stdout + chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = keepEnd(stderr + chunk);
    });
    child.on('error', (error) => {
      finish({ exitCode: 127, output: `${stdout}${stderr}${error.message}\n` });
    });
    child.on('close', (code) => {
      // What the call left in its group goes with it.
      if (child.pid !== undefined)
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // Nothing was left.
        }
      finish(
        stopped === null
          ? { exitCode: code ?? 1, output: `${stdout}${stderr}` }
          : { exitCode: STOPPED_EXIT_CODE, output: `${stdout}${stderr}${stopped}\n` },
      );
    });
  });
}

const refused = (why: string): BuilderRefusal => ({ refused: why });

/** The words 10db runs for the builder as one shell line, each word quoted when it needs it. */
export function builderCommandLine(argv: readonly string[]): string {
  return argv.map(shellWord).join(' ');
}

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

/** What the git dir's HEAD file says, or null when it can't be read. */
function readHead(gitDir: string): string | null {
  try {
    return readFileSync(join(gitDir, 'HEAD'), 'utf8');
  } catch {
    return null;
  }
}

/** The branch a HEAD file names, or null for a detached or unreadable HEAD. */
function branchOfHead(head: string | null): string | null {
  return /^ref: refs\/heads\/(\S+)\n?$/.exec(head ?? '')?.[1] ?? null;
}

/** HEAD as a card line names it. */
const shownHead = (head: string | null): string =>
  head === null ? 'unreadable' : (branchOfHead(head) ?? head.trim());

/**
 * One pass's approved calls. HEAD is read before and after each: one that moved it (a hook that
 * switched the branch) leaves every later call refused until HEAD is back where it was, since the
 * branch HEAD names is the one the next call may write.
 */
export function createPassGitSession(
  /** Read for each call, so it runs with the project's env and rules as they are then. */
  optsOf: () => Parameters<typeof runPassGit>[1],
): (call: Extract<PassGitCall, { kind: 'run' }>) => Promise<BuilderRun | BuilderRefusal> {
  let expected: string | null = null;
  return async (call) => {
    const opts = optsOf();
    const gitDir = join(opts.checkout, '.git');
    const before = readHead(gitDir);
    if (expected !== null && before !== expected)
      return refused(
        `HEAD moved while 10db ran an earlier call for you in this pass (it named ${shownHead(expected)} and now names ${shownHead(before)}), so 10db runs no other commit, push or merge until it is back. Switch back to ${shownHead(expected)} yourself, then ask again.`,
      );
    expected = null;
    const ran = await runPassGit(call, opts);
    const after = readHead(gitDir);
    if (after !== before) expected = before;
    return ran;
  };
}

/** Where a pass's commit or merge runs: the gate's sandbox, built from the lane profile. */
export interface PassGitSandbox {
  readonly gate: GateSandbox;
  /** The project's gate input: its env (never the account's credentials), rules and checkouts. */
  readonly input: Pick<GateRunInput, 'project' | 'env' | 'rules' | 'checkouts'>;
  /** The builder's home, where their git config gives the commit its identity. */
  readonly home: string;
}

const withoutSecrets = (env: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter(([name]) => !SECRET_VARIABLES.includes(name)));

/** A path's real path, or the path itself when it has none. */
function realOr(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/** The builder's global git config, as git finds it: `~/.gitconfig`, else the XDG one. */
function globalGitConfig(home: string, env: Readonly<Record<string, string>>): string | null {
  const xdg = env['XDG_CONFIG_HOME'];
  const candidates = [
    join(home, '.gitconfig'),
    join(xdg !== undefined && isAbsolute(xdg) ? xdg : join(home, '.config'), 'git', 'config'),
  ];
  return candidates.find((file) => existsSync(file)) ?? null;
}

/**
 * Runs a pass's commit, push or merge the builder allowed on a card, as they would in a terminal,
 * at the checkout's root with `GIT_DIR` and `GIT_WORK_TREE` set to the checkout's own (so no
 * repository a lane made inside it is the one that runs), the daemon's own git hardening (no
 * attributes from the tree, the worktree or a file, `core.fsmonitor` off), the daemon's own git
 * and gh binaries, prompts off and no account credential in the environment. A commit or a merge
 * runs inside the gate's sandbox (`sandbox`), so its hooks run contained: the hook runners read
 * files a lane writes (`lefthook-local.yml`, `.husky/`, `node_modules/.bin`). It writes the git
 * dir but its hooks and config, and reads the builder's git config for their identity. A push and
 * a pull request merge need the builder's credentials, so they run outside it, with
 * `core.hooksPath` at `/dev/null`: the repository's push hooks don't run. A push goes only to a
 * remote the checkout lists, and a push of the current branch only when that branch is neither
 * `main` nor `baseBranch`. `signal` ends it with its session.
 */
export async function runPassGit(
  call: Extract<PassGitCall, { kind: 'run' }>,
  opts: {
    readonly checkout: string;
    readonly baseBranch: string;
    readonly env: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
    /** The daemon's resolved git and gh (`resolveGit`, `resolveGh`). */
    readonly bins: { readonly git: string; readonly gh: string | null };
    /** Null where 10db has no sandbox: then it runs no commit or merge, whose hooks it can't contain. */
    readonly sandbox: PassGitSandbox | null;
    readonly clock?: Clock;
  },
): Promise<BuilderRun | BuilderRefusal> {
  const clock = opts.clock ?? systemClock;
  const place = ownGitDir(opts.checkout);
  if (place === null)
    return refused(
      "10db runs a pass's commit, push or merge only in a checkout whose .git is its own folder.",
    );
  const [program, ...args] = call.argv;
  const contained = program === 'git' && args[0] !== 'push';
  if (contained && opts.sandbox === null)
    return refused(
      "10db runs a pass's commit or merge only inside the sandbox, where the repository's hooks are contained, and this daemon runs none.",
    );
  // The daemon's own git hardening, as git config gh's git reads too: no attributes file and no
  // fsmonitor, beside `GIT_ATTR_SOURCE` at the empty tree below. Outside the sandbox no hook runs.
  const config = Object.entries({
    ...NO_ATTRIBUTES_CONFIG,
    'core.fsmonitor': 'false',
    // Nor is a submodule pushed along, whatever the repository's config says.
    ...(contained ? {} : { 'core.hooksPath': '/dev/null', 'push.recurseSubmodules': 'no' }),
  });
  const gitEnv = {
    GIT_DIR: place.gitDir,
    GIT_WORK_TREE: place.root,
    GIT_CONFIG_COUNT: String(config.length),
    ...Object.fromEntries(
      config.flatMap(([key, value], at) => [
        [`GIT_CONFIG_KEY_${String(at)}`, key],
        [`GIT_CONFIG_VALUE_${String(at)}`, value],
      ]),
    ),
    GIT_TERMINAL_PROMPT: '0',
  };
  const base = {
    ...withoutSecrets(
      Object.fromEntries(Object.entries(opts.env).filter(([name]) => !name.startsWith('GIT_'))),
    ),
    ...gitEnv,
    GH_PROMPT_DISABLED: '1',
  };
  const bare = (env: Readonly<Record<string, string>>, ...gitArgs: string[]) =>
    run([opts.bins.git, ...gitArgs], place.root, env, opts.signal, clock);
  // No attributes from the tree or the worktree either, so no filter or driver a lane named runs.
  const empty = await bare(base, 'hash-object', '-t', 'tree', '--stdin');
  if (empty.exitCode !== 0)
    return refused("10db couldn't prepare git for this checkout, so it won't run the call.");
  const attrSource = empty.output.trim();
  const env = { ...base, GIT_ATTR_SOURCE: attrSource };
  const git = (...gitArgs: string[]) => bare(env, ...gitArgs);
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
  if (contained && opts.sandbox !== null) {
    // The call moves the current branch alone: HEAD and every other ref, `main`, the base branch
    // and other lanes' branches among them, stay closed to it and to the hooks it starts.
    const current = branchOfHead(readHead(place.gitDir));
    if (current === null)
      return refused(
        "This checkout's HEAD names no branch, and 10db runs a pass's commit or merge only on one. Switch to a branch first.",
      );
    const refs = await git('for-each-ref', '--format=%(refname)', 'refs/heads');
    if (refs.exitCode !== 0)
      return refused("10db couldn't list this checkout's branches, so it won't run the call.");
    const own = `refs/heads/${current}`.toLowerCase();
    const closed = [
      ...new Set([
        ...refs.output.split('\n').filter((ref) => ref !== ''),
        'refs/heads/main',
        `refs/heads/${opts.baseBranch}`,
      ]),
    ].filter((ref) => ref.toLowerCase() !== own);
    return runContained(
      opts.bins.git,
      args,
      opts.sandbox,
      place,
      closed,
      {
        ...gitEnv,
        GIT_ATTR_SOURCE: attrSource,
      },
      opts.signal,
      clock,
    );
  }
  // The daemon's own git and gh, never a program the session's PATH finds; gh's git is that git too.
  const binary = program === 'gh' ? opts.bins.gh : opts.bins.git;
  if (binary === null)
    return refused('gh is not installed where 10db looks for it, so 10db could not run this call.');
  const path = opts.env['PATH'];
  return run(
    [binary, ...args],
    place.root,
    {
      ...env,
      PATH:
        path === undefined
          ? dirname(opts.bins.git)
          : `${dirname(opts.bins.git)}${delimiter}${path}`,
    },
    opts.signal,
    clock,
  );
}

/**
 * A commit or merge inside the gate's sandbox: git runs with the daemon's hardening and the
 * builder's git config, as srt's command, and the sandbox's files go once it ends.
 */
async function runContained(
  git: string,
  args: readonly string[],
  sandbox: PassGitSandbox,
  place: { readonly root: string; readonly gitDir: string },
  closedRefs: readonly string[],
  gitEnv: Readonly<Record<string, string>>,
  signal: AbortSignal,
  clock: Clock,
): Promise<BuilderRun | BuilderRefusal> {
  const identity = globalGitConfig(sandbox.home, sandbox.input.env);
  const assignments = Object.entries({
    ...gitEnv,
    // The sandbox points git at no global config; the builder's own gives the commit its author.
    GIT_CONFIG_GLOBAL: identity ?? '/dev/null',
  }).map(([name, value]) => `${name}=${singleQuoted(value)}`);
  const command = ['exec /usr/bin/env', ...assignments, ...[git, ...args].map(singleQuoted)].join(
    ' ',
  );
  let contained;
  try {
    contained = await sandbox.gate.forRun({
      ...sandbox.input,
      env: withoutSecrets(sandbox.input.env),
      command,
      approvedGit: {
        gitDir: place.gitDir,
        // A dotfiles link opens the file it leads to as well; the builder's home is no lane's to write.
        globalConfig: identity === null ? [] : [...new Set([identity, realOr(identity)])],
        closedRefs,
      },
    });
  } catch (error) {
    return refused(
      `10db couldn't build the sandbox this call runs in, so it didn't run: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    // srt's debug log would bury what git printed.
    const host = Object.fromEntries(
      Object.entries(contained.env).filter(([name]) => name !== 'SRT_DEBUG'),
    );
    return await run([contained.file, ...contained.args], contained.cwd, host, signal, clock);
  } finally {
    // Its files are swept later if they can't go now; the call's result stands.
    await contained.dispose().catch(() => undefined);
  }
}
