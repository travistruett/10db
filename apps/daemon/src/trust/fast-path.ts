import { lstatSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import {
  foldPathCase,
  isSecretFileName,
  isWithin,
  isWithinOnEveryReading,
  plainCommandWords,
  readOnlyShellRefusal,
  realPathReadings,
} from '../guard';

/** What a Codex `apply_patch` hunk does to its file. */
export const PatchHunk = { Add: 'add', Update: 'update', Delete: 'delete', Move: 'move' } as const;
export type PatchHunk = (typeof PatchHunk)[keyof typeof PatchHunk];

/** A tool call as 10db's judge reads it, under the guard's tool names. */
export interface LimitCall {
  readonly toolName: string;
  readonly input: unknown;
  /** Where the call runs: an absolute directory. */
  readonly cwd: string;
  /** The `apply_patch` hunk a Codex edit came from; null for every other call. */
  readonly hunk: PatchHunk | null;
}

export interface FastPathContext {
  /** The session's checkout. */
  readonly checkout: string;
  /** The session's own temp directory. */
  readonly tmpDir: string;
  /** The session's secret files: every `.env*` file and link, and each link's real path. */
  readonly secretFiles: readonly string[];
  /**
   * The untracked and ignored entries the checkout held when the session started, relative to it, as git lists
   * them (an ignored folder once, ending in `/`).
   */
  readonly preExisting: readonly string[];
}

/** Key and credential files, by their last segment, case-folded, beside the sandbox's own `.env*`. */
const SECRET_NAME_PATTERNS: readonly RegExp[] = [
  /\.(pem|key|p12|pfx|tfvars)$/,
  /^id_(rsa|ed25519|ecdsa|dsa)/,
  /^(credentials|secrets?)(\.|$)/,
];
const SECRET_NAMES: ReadonlySet<string> = new Set([
  '.npmrc',
  '.netrc',
  '.pypirc',
  '.git-credentials',
]);

function nameIsSecret(path: string): boolean {
  const name = foldPathCase(basename(path));
  return (
    isSecretFileName(name) ||
    SECRET_NAMES.has(name) ||
    SECRET_NAME_PATTERNS.some((pattern) => pattern.test(name))
  );
}

/** The real paths of the session's secret files, folded, so a spelling of the checkout's path can't hide one. */
function foldedSecrets(secretFiles: readonly string[]): Set<string> {
  const folded = new Set<string>();
  for (const file of secretFiles) {
    folded.add(foldPathCase(file));
    for (const real of realPathReadings(file).paths) folded.add(foldPathCase(real));
  }
  return folded;
}

/**
 * Whether `path` (absolute) may name a secret: its last segment is one, or a real path it leads to is in the
 * session's secret files or is one. A path that can't be resolved counts as one.
 */
export function namesSecret(path: string, secretFiles: readonly string[]): boolean {
  if (nameIsSecret(path)) return true;
  const readings = realPathReadings(path);
  if (!readings.complete) return true;
  const secrets = foldedSecrets(secretFiles);
  return readings.paths.some((real) => nameIsSecret(real) || secrets.has(foldPathCase(real)));
}

function field(input: Readonly<Record<string, unknown>>, name: string): string | null {
  const value = input[name];
  return typeof value === 'string' ? value : null;
}

const from = (cwd: string, path: string): string => (isAbsolute(path) ? path : resolve(cwd, path));

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** A word longer than this is not split into the paths it may hold; the call goes to the model. */
const MAX_OPTION_WORD = 256;

/**
 * The paths a word may name, or null for a word too long to split: a plain word; a long option's value after
 * its `=`; every tail of a short option, since its value may be attached; and the part after a `:`, which
 * names a file in a revision (`HEAD:.env`).
 */
function pathsOf(word: string): string[] | null {
  if (word.length > MAX_OPTION_WORD) return null;
  const paths: string[] = [];
  if (word.startsWith('--')) {
    const value = /^--[A-Za-z][\w-]*=(.*)$/s.exec(word)?.[1];
    if (value !== undefined) paths.push(value);
  } else if (word.startsWith('-') && word.length > 1) {
    for (let at = 1; at < word.length; at += 1) paths.push(word.slice(at));
  } else {
    paths.push(word);
  }
  const colon = word.lastIndexOf(':');
  if (colon >= 0) paths.push(word.slice(colon + 1));
  return paths.filter((p) => p !== '');
}

const SEARCHES: ReadonlySet<string> = new Set([
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'ack',
  'diff',
]);
/** A `git log` option that prints file contents: a patch, a word diff or a line range. */
const LOG_PATCH = /^(-[^-]*[puUL]|--patch.*|--unified.*|--cc|--word-diff.*|--full-diff|--dd)$/;

/** The words that aren't options: a search's pattern and targets. */
const plainWords = (args: readonly string[]): string[] =>
  args.filter((a) => a === '-' || !a.startsWith('-'));

/** Whether a search or diff may read a whole directory: no target, or one that is a directory. */
function searchesDirectory(cmd: string, args: readonly string[], cwd: string): boolean {
  const plain = plainWords(args);
  // A search's first plain word is its pattern; diff's every word is a target.
  const targets = cmd === 'diff' ? plain : plain.slice(1);
  if (targets.length === 0) return true;
  return plain.some((word) => isDirectory(from(cwd, word)));
}

function printsHistory(args: readonly string[]): boolean {
  const [sub = '', ...rest] = args;
  if (sub === 'show' || sub === 'diff' || sub === 'grep') return true;
  return sub === 'log' && rest.some((a) => LOG_PATCH.test(a));
}

function readsEnvironment(args: readonly string[]): boolean {
  return args.some(
    (a) =>
      a === '-n' ||
      a === '--null-input' ||
      (a.startsWith('-') && !a.startsWith('--') && a.includes('n')) ||
      a === 'env' ||
      a.includes('$ENV'),
  );
}

function bashOnlyReads(command: string, cwd: string, secretFiles: readonly string[]): boolean {
  if (readOnlyShellRefusal(command) !== null) return false;
  const segments = plainCommandWords(command);
  if (segments === null) return false;
  for (const [cmd = '', ...args] of segments) {
    if (cmd === 'cd') return false;
    if (SEARCHES.has(cmd) && searchesDirectory(cmd, args, cwd)) return false;
    if (cmd === 'git' && printsHistory(args)) return false;
    if (cmd === 'jq' && readsEnvironment(args)) return false;
    for (const word of args) {
      if (/[*?[]/.test(word) || word.startsWith('~')) return false;
      const paths = pathsOf(word);
      if (paths === null) return false;
      if (paths.some((p) => namesSecret(from(cwd, p), secretFiles))) return false;
    }
  }
  return true;
}

const EDIT_TOOLS: Readonly<Record<string, string>> = {
  Edit: 'file_path',
  Write: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

function editStaysIn(call: LimitCall, path: string | null, ctx: FastPathContext): boolean {
  if (path === null || path === '') return false;
  if (call.hunk === PatchHunk.Delete || call.hunk === PatchHunk.Move) return false;
  const target = from(call.cwd, path);
  if (namesSecret(target, ctx.secretFiles)) return false;
  // `..` is kept as written: after a link it means something else, and both readings must be inside.
  const written = isAbsolute(path) ? path : `${call.cwd}${sep}${path}`;
  if (overwritesPreExisting(written, ctx)) return false;
  return [ctx.checkout, ctx.tmpDir].some((dir) => isWithinOnEveryReading(dir, written));
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether an edit changes a file that was there before the session and that git can't bring back: it exists,
 * and on some reading it is a pre-existing entry or under one.
 */
function overwritesPreExisting(written: string, ctx: FastPathContext): boolean {
  if (!exists(written)) return false;
  return ctx.preExisting.some((entry) => isWithin(join(ctx.checkout, entry), written));
}

/**
 * Whether a call can't cross a limit, so 10db's judge allows it with no model: a read, a listing, an edit in the
 * checkout or the session's temp dir, a read-only command, a subagent launch, and 10db's own tools, and never a
 * call that can reach a secret, search a directory, print history or the environment, or delete or move a file.
 */
export function fastPathAllows(call: LimitCall, ctx: FastPathContext): boolean {
  const { input } = call;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false;
  // An object is a record of unknown values here; each field is read by its type.
  const fields = input as Readonly<Record<string, unknown>>;
  const tool = call.toolName;
  if (tool.startsWith('mcp__10db__')) return true;
  switch (tool) {
    case 'Task':
    case 'Agent':
    case 'TodoWrite':
    case 'Skill':
      return true;
    case 'Read':
    case 'LS': {
      const path = field(fields, tool === 'Read' ? 'file_path' : 'path') ?? call.cwd;
      return !namesSecret(from(call.cwd, path), ctx.secretFiles);
    }
    case 'Glob': {
      const pattern = field(fields, 'pattern');
      const path = field(fields, 'path') ?? call.cwd;
      return (
        pattern !== null &&
        !pattern.split('/').some((segment) => nameIsSecret(segment)) &&
        !namesSecret(from(call.cwd, path), ctx.secretFiles)
      );
    }
    case 'Grep': {
      const path = field(fields, 'path');
      if (path === null) return false;
      const target = from(call.cwd, path);
      return isRegularFile(target) && !namesSecret(target, ctx.secretFiles);
    }
    case 'Bash': {
      const command = field(fields, 'command');
      return command !== null && bashOnlyReads(command, call.cwd, ctx.secretFiles);
    }
    default: {
      const pathField = EDIT_TOOLS[tool];
      if (pathField === undefined || !Object.hasOwn(EDIT_TOOLS, tool)) return false;
      return editStaysIn(call, field(fields, pathField), ctx);
    }
  }
}
