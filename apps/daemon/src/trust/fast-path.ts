import { lstatSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path';
import {
  foldPathCase,
  isSecretFileName,
  isWithin,
  isWithinOnEveryReading,
  plainCommandWords,
  readOnlyShellRefusal,
  realPathReadings,
} from '../guard';
import { ChatToolName } from '@10db/contracts';
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
  /**
   * The folders the session's profile opens of its setup (`FileAccessContext.setupReads`): its setup dir and the
   * builder's kept skill and plugin folders, less any that is or lies in a secret. Only a Markdown file there, a
   * skill's instructions and references, is read with no model; anything else in them goes to the judge.
   */
  readonly setupReads: readonly string[];
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
 * Whether `path` (absolute) may name a secret: its last segment is one, or a real path it leads to is one, is
 * one of the session's secret files, or lies in one (a secret folder). A path that can't be resolved counts as one.
 */
export function namesSecret(path: string, secretFiles: readonly string[]): boolean {
  if (nameIsSecret(path)) return true;
  const readings = realPathReadings(path);
  if (!readings.complete) return true;
  const secrets = [...foldedSecrets(secretFiles)];
  return readings.paths.some((real) => {
    const folded = foldPathCase(real);
    // A secret folder (`.env.d/`) holds secrets under any name.
    return (
      nameIsSecret(real) || secrets.some((s) => folded === s || folded.startsWith(`${s}${sep}`))
    );
  });
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

/**
 * Whether a tool's path is plain text: Claude Code trims it and expands a leading `~`, so a path 10db would read
 * as a name inside the checkout can open another file. Such a path goes to the judge.
 */
const isPlainPath = (path: string): boolean => path === path.trim() && !path.startsWith('~');

/** Whether every reading of a path, with its `..` kept as written, is inside the checkout or the temp dir. */
function staysIn(path: string, cwd: string, ctx: FastPathContext): boolean {
  // `..` is kept as written: after a link it means something else, and both readings must be inside.
  const written = isAbsolute(path) ? path : `${cwd}${sep}${path}`;
  return [ctx.checkout, ctx.tmpDir].some((dir) => isWithinOnEveryReading(dir, written));
}

/** Whether a path is a Markdown file whose every reading is inside one of the session's setup reads. */
function inSetup(path: string, cwd: string, ctx: FastPathContext): boolean {
  const written = isAbsolute(path) ? path : `${cwd}${sep}${path}`;
  // The name as written and every real path it leads to, so a link named `x.md` can't open another file.
  if (!isMarkdown(written) || !realPathReadings(written).paths.every(isMarkdown)) return false;
  return ctx.setupReads.some((dir) => isWithinOnEveryReading(dir, written));
}

const isMarkdown = (path: string): boolean => extname(path).toLowerCase() === '.md';

/** Whether a read or a listing stays where the session may read freely: inside, or in its setup. */
const readStaysIn = (path: string, cwd: string, ctx: FastPathContext): boolean =>
  staysIn(path, cwd, ctx) || inSetup(path, cwd, ctx);

/** Brace, extglob and escape syntax: each can spell a path no segment-by-segment check sees. */
const GLOB_SYNTAX = /[{}\\]|[@!+*?]\(/;

/** A pattern's wildcard characters, and the control characters no plain name holds. */
const GLOB_MAGIC = /[*?[\]]/;
// eslint-disable-next-line no-control-regex -- the point is to match them
const CONTROL = /[\x00-\x1f\x7f]/;

/** Whether a pattern segment is plain: no padding whitespace and no control character. */
const isPlainSegment = (segment: string): boolean =>
  segment === segment.trim() && !CONTROL.test(segment);

/**
 * Whether a glob pattern matches only below the folder it is run in: plain text and syntax, not absolute,
 * home-relative or climbing.
 */
function patternStaysBelow(pattern: string): boolean {
  const segments = pattern.split('/');
  return (
    isPlainPath(pattern) &&
    !GLOB_SYNTAX.test(pattern) &&
    !isAbsolute(pattern) &&
    !segments.includes('..') &&
    segments.every(isPlainSegment)
  );
}

/**
 * Whether a Glob may run with no model: a plain pattern, and a search folder and the pattern's literal prefix
 * inside. The tool runs `rg --files --null --glob <pattern> --sort=modified --no-ignore --hidden` there, which
 * follows no link inside the tree, so past the prefix the pattern can't reach outside the search folder.
 */
function globStaysIn(pattern: string, path: string, cwd: string, ctx: FastPathContext): boolean {
  if (!patternStaysBelow(pattern) || !isPlainPath(path)) return false;
  const segments = pattern.split('/');
  if (segments.some((segment) => nameIsSecret(segment))) return false;
  const at = segments.findIndex((segment) => GLOB_MAGIC.test(segment));
  const prefix = (at === -1 ? segments : segments.slice(0, at)).join('/');
  return [path, prefix === '' ? path : join(path, prefix)].every(
    (reach) => !namesSecret(from(cwd, reach), ctx.secretFiles) && staysIn(reach, cwd, ctx),
  );
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
  return !namesSecret(target, ctx.secretFiles) && readStaysIn(word, cwd, ctx);
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
  if (path === null || path === '' || !isPlainPath(path)) return false;
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

const OWN_TOOL_PREFIX = 'mcp__10db__';

/**
 * 10db's own tools that cross a limit: a push and a pull request send the builder's work out, a merge writes to
 * a shared branch. The fast path never settles them, so a judge reads each call.
 */
export const JUDGED_OWN_TOOLS: ReadonlySet<string> = new Set([
  ChatToolName.PushBranch,
  ChatToolName.OpenPullRequest,
  ChatToolName.MergePullRequest,
]);

/**
 * Whether a call can't cross a limit, so 10db's judge allows it with no model: a read, a listing, an edit in the
 * checkout or the session's temp dir, a listed read command with listed options on files inside, a subagent
 * launch, and 10db's own tools but the ones that send work out or merge, and never a call that can reach a secret, search a directory, print history or
 * the environment, or delete or move a file.
 */
export function fastPathAllows(call: LimitCall, ctx: FastPathContext): boolean {
  const { input } = call;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false;
  // An object is a record of unknown values here; each field is read by its type.
  const fields = input as Readonly<Record<string, unknown>>;
  const tool = call.toolName;
  if (tool.startsWith(OWN_TOOL_PREFIX))
    return !JUDGED_OWN_TOOLS.has(tool.slice(OWN_TOOL_PREFIX.length));
  switch (tool) {
    case 'Task':
    case 'Agent':
    case 'TodoWrite':
    case 'Skill':
      return true;
    case 'Read':
    case 'LS': {
      const path = field(fields, tool === 'Read' ? 'file_path' : 'path') ?? call.cwd;
      return (
        isPlainPath(path) &&
        !namesSecret(from(call.cwd, path), ctx.secretFiles) &&
        readStaysIn(path, call.cwd, ctx)
      );
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
        isPlainPath(path) &&
        isRegularFile(target) &&
        !namesSecret(target, ctx.secretFiles) &&
        readStaysIn(path, call.cwd, ctx)
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
