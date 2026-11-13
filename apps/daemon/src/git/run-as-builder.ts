import { spawn } from 'node:child_process';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
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
  },
): Promise<BuilderRun | BuilderRefusal> {
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
    ...(contained ? {} : { 'core.hooksPath': '/dev/null' }),
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
    run([opts.bins.git, ...gitArgs], place.root, env, opts.signal);
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
    // The commit moves the current branch; `main` and the base branch stay closed but for that one.
    const head = await git('symbolic-ref', '--short', '-q', 'HEAD');
    const current = head.exitCode === 0 ? head.output.trim().toLowerCase() : '';
    const kept = [...new Set(['main', opts.baseBranch])].filter(
      (branch) => branch.toLowerCase() !== current,
    );
    return runContained(
      opts.bins.git,
      args,
      opts.sandbox,
      place,
      kept,
      {
        ...gitEnv,
        GIT_ATTR_SOURCE: attrSource,
      },
      opts.signal,
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
  keptBranches: readonly string[],
  gitEnv: Readonly<Record<string, string>>,
  signal: AbortSignal,
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
        globalConfig: identity === null ? [] : [identity],
        keptBranches,
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
    return await run([contained.file, ...contained.args], contained.cwd, host, signal);
  } finally {
    // Its files are swept later if they can't go now; the call's result stands.
    await contained.dispose().catch(() => undefined);
  }
}
