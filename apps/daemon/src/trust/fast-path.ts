import { lstatSync, readdirSync, statSync } from 'node:fs';
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
import { Operands, readCallOf, type ReadCall } from './read-allowlist';

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

// Lowercased on every file system, not only where case is folded: on a case-sensitive one `.ENV` is another
// file, but sending it to the judge costs a call, while fast-pathing a secret would read it unjudged.
function nameIsSecret(path: string): boolean {
  const name = foldPathCase(basename(path)).toLowerCase();
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

/** Whether every reading of a path, with its `..` kept as written, is inside the checkout or the temp dir. */
function staysIn(path: string, cwd: string, ctx: FastPathContext): boolean {
  // `..` is kept as written: after a link it means something else, and both readings must be inside.
  const written = isAbsolute(path) ? path : `${cwd}${sep}${path}`;
  return [ctx.checkout, ctx.tmpDir].some((dir) => isWithinOnEveryReading(dir, written));
}

/** Brace, extglob and escape syntax: each can spell a path no segment-by-segment check sees. */
const GLOB_SYNTAX = /[{}\\]|[@!+*?]\(/;
const GLOB_MAGIC = /[*?[\]]/;
/** The most directory entries a glob's search is read for links before the judge is asked instead. */
const GLOB_WALK_MAX = 5000;

/** Whether a glob pattern matches only below the folder it is run in: plain syntax, not absolute or climbing. */
function patternStaysBelow(pattern: string): boolean {
  return (
    !GLOB_SYNTAX.test(pattern) &&
    !isAbsolute(pattern) &&
    !pattern.startsWith('~') &&
    !pattern.split('/').includes('..')
  );
}

/**
 * The leading segments of a pattern with no wildcard in them, whether the pattern has a wildcard at all, and how
 * many folder levels below the prefix it can descend (unbounded for `**`).
 */
function splitPattern(pattern: string): {
  readonly prefix: string;
  readonly wild: boolean;
  readonly depth: number;
} {
  const segments = pattern.split('/');
  const at = segments.findIndex((segment) => GLOB_MAGIC.test(segment));
  if (at === -1) return { prefix: pattern, wild: false, depth: 0 };
  const rest = segments.slice(at);
  return {
    prefix: segments.slice(0, at).join('/'),
    wild: true,
    depth: rest.includes('**') ? Infinity : rest.length - 1,
  };
}

/**
 * Whether the folders a pattern can descend into, `depth` levels below `root`, hold no link at all: the tool may
 * follow one and chain through more. A tree too large to read within the limit counts as holding one. Every
 * folder is entered, `.git` and `node_modules` too, since a pattern that can reach them reads them.
 */
function holdsNoLink(root: string, depth: number): boolean {
  let seen = 0;
  const pending: { readonly dir: string; readonly level: number }[] = [{ dir: root, level: 0 }];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined) break;
    let entries;
    try {
      entries = readdirSync(next.dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      seen += 1;
      if (seen > GLOB_WALK_MAX || entry.isSymbolicLink()) return false;
      if (entry.isDirectory() && next.level < depth) {
        pending.push({ dir: join(next.dir, entry.name), level: next.level + 1 });
      }
    }
  }
  return true;
}

/** Whether a Glob may run with no model: plain syntax, and a search that stays inside and meets no link. */
function globStaysIn(pattern: string, path: string, cwd: string, ctx: FastPathContext): boolean {
  if (!patternStaysBelow(pattern)) return false;
  if (pattern.split('/').some((segment) => nameIsSecret(segment))) return false;
  const { prefix, wild, depth } = splitPattern(pattern);
  const reach = prefix === '' ? path : join(path, prefix);
  const target = from(cwd, reach);
  if (namesSecret(target, ctx.secretFiles) || !staysIn(reach, cwd, ctx)) return false;
  return !wild || (isDirectory(target) && holdsNoLink(target, depth));
}

/** Whether a read command may open or list `word`: an existing, non-secret file (or folder) inside. */
function readTargetIsSafe(
  word: string,
  cwd: string,
  ctx: FastPathContext,
  folders: boolean,
): boolean {
  if (word === '-') return true;
  const target = from(cwd, word);
  if (!isRegularFile(target) && !(folders && isDirectory(target))) return false;
  return !namesSecret(target, ctx.secretFiles) && staysIn(word, cwd, ctx);
}

function operandsAreSafe(read: ReadCall, cwd: string, ctx: FastPathContext): boolean {
  switch (read.operands) {
    case Operands.Text:
      return true;
    case Operands.Revisions:
      // A `rev:path` names a blob, and a leading `:` is pathspec magic.
      return read.targets.every((word) => !word.includes(':'));
    case Operands.Files:
      return read.targets.every((word) => readTargetIsSafe(word, cwd, ctx, false));
    case Operands.Listings: {
      const targets = read.targets.length === 0 ? [cwd] : read.targets;
      return targets.every((word) => readTargetIsSafe(word, cwd, ctx, true));
    }
  }
}

/**
 * Whether every segment of a command is a listed read command with only allowed options, reading only regular,
 * non-secret files inside the checkout or the temp dir (`read-allowlist.ts`).
 */
function bashOnlyReads(command: string, cwd: string, ctx: FastPathContext): boolean {
  if (readOnlyShellRefusal(command) !== null) return false;
  const segments = plainCommandWords(command);
  if (segments === null) return false;
  return segments.every((segment) => {
    const read = readCallOf(segment);
    return read !== null && operandsAreSafe(read, cwd, ctx);
  });
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
  const written = isAbsolute(path) ? path : `${call.cwd}${sep}${path}`;
  if (overwritesPreExisting(written, ctx)) return false;
  return staysIn(path, call.cwd, ctx);
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
 * Whether an edit changes a file that was there before the session and that git can't bring back: it exists on
 * some reading (as the kernel opens it, or with `..` collapsed), and on some reading it is a pre-existing entry
 * or under one.
 */
function overwritesPreExisting(written: string, ctx: FastPathContext): boolean {
  if (!exists(written) && !realPathReadings(written).paths.some(exists)) return false;
  return ctx.preExisting.some((entry) => isWithin(join(ctx.checkout, entry), written));
}

/**
 * Whether a call can't cross a limit, so 10db's judge allows it with no model: a read, a listing, an edit in the
 * checkout or the session's temp dir, a listed read command with listed options on files inside, a subagent
 * launch, and 10db's own tools, and never a call that can reach a secret, search a directory, print history or
 * the environment, or delete or move a file.
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
      return !namesSecret(from(call.cwd, path), ctx.secretFiles) && staysIn(path, call.cwd, ctx);
    }
    case 'Glob': {
      const pattern = field(fields, 'pattern');
      const path = field(fields, 'path') ?? call.cwd;
      return pattern !== null && globStaysIn(pattern, path, call.cwd, ctx);
    }
    case 'Grep': {
      const path = field(fields, 'path');
      if (path === null) return false;
      const target = from(call.cwd, path);
      return (
        isRegularFile(target) &&
        !namesSecret(target, ctx.secretFiles) &&
        staysIn(path, call.cwd, ctx)
      );
    }
    case 'Bash': {
      const command = field(fields, 'command');
      return command !== null && bashOnlyReads(command, call.cwd, ctx);
    }
    default: {
      const pathField = EDIT_TOOLS[tool];
      if (pathField === undefined || !Object.hasOwn(EDIT_TOOLS, tool)) return false;
      return editStaysIn(call, field(fields, pathField), ctx);
    }
  }
}
