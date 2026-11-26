import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, relative, dirname, isAbsolute, sep } from 'node:path';
import { ProgramKey } from '@10db/contracts';
import { redirectionSpan, type ShellSegment } from '../guard';
import { grantCallSummary } from './grants';
import {
  ASSIGNMENT_WORD,
  INTERPRETERS,
  leadingCommand,
  MAKE_QUIET_OPTIONS,
  MAKES,
  repoPath,
} from './leading-command';
import { within } from './make-rules';
import { Operands, readCallOf } from './read-allowlist';

/** A redirection word's operator: the descriptor or `&` before it, then the operator itself. */
const REDIRECTION_OPERATOR = /^(?:\d+|&)?(?:<<<|<<-?|<>|<&|>>|>\||>&|<|>)/;
const HERE_OPERATOR = /<<-?$|<<<$/;
const DESCRIPTOR_TARGET = /^(?:\d+|-)$/;

/** Options of each package runner that take the next word as their value. */
const VALUED_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  pnpm: new Set(['--filter', '-F', '--dir', '-C', '--workspace-dir']),
  npm: new Set(['--prefix', '--workspace', '-w']),
  yarn: new Set(['--cwd']),
  bun: new Set(['--cwd', '--filter']),
};
const NO_VALUED_OPTIONS: ReadonlySet<string> = new Set();
const NPM_RUNS: ReadonlySet<string> = new Set(['run', 'run-script', 'rum', 'urun']);
const NPM_SHORTCUTS: ReadonlySet<string> = new Set(['test', 'start', 'stop', 'restart']);
const PACKAGE_RUNNER_KEY = /^(?:pnpm|npm run|yarn|bun)(?: |$)/;

function inside(root: string, path: string): boolean {
  const rel = posix.relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !posix.isAbsolute(rel));
}

/** Where a redirection may write or read: the checkout, the temp folder, `/dev/null` or another descriptor. */
function redirectTargetIsSafe(
  operator: string,
  target: string,
  dir: string,
  checkout: string,
): boolean {
  if (HERE_OPERATOR.test(operator)) return false;
  if (operator.endsWith('&') && DESCRIPTOR_TARGET.test(target)) return true;
  if (target === '' || target === '/dev/null') return target !== '';
  const path = target.startsWith('/')
    ? posix.normalize(target)
    : posix.normalize(posix.join(checkout, dir, target));
  return [checkout, tmpdir(), '/tmp'].some((root) => inside(root, path));
}

/** Whether every redirection of the segment stays in the checkout or the temp folder, with a fixed target. */
function redirectionsAreSafe(segment: ShellSegment, dir: string, checkout: string): boolean {
  const { words, dynamicWords } = segment;
  for (let at = 0; at < words.length; at += 1) {
    const span = redirectionSpan(words, at);
    if (span === 0) continue;
    if (dynamicWords.slice(at, at + span).some(Boolean)) return false;
    const word = words[at] ?? '';
    const operator = REDIRECTION_OPERATOR.exec(word)?.[0] ?? '';
    const target = span === 2 ? (words[at + 1] ?? '') : word.slice(operator.length);
    if (!redirectTargetIsSafe(operator, target, dir, checkout)) return false;
    at += span - 1;
  }
  return true;
}

/** The words of a segment with its redirections taken out, each with whether the shell fills it in. */
function wordsWithoutRedirections(
  words: readonly string[],
  dynamic: readonly boolean[],
): { readonly words: string[]; readonly dynamic: boolean[] } {
  const kept = { words: [] as string[], dynamic: [] as boolean[] };
  for (let at = 0; at < words.length; at += 1) {
    const span = redirectionSpan(words, at);
    if (span > 0) {
      at += span - 1;
      continue;
    }
    kept.words.push(words[at] ?? '');
    kept.dynamic.push(dynamic[at] === true);
  }
  return kept;
}

/**
 * The segments after the leading command are a pipe into commands the fast path's read list allows, taking no
 * file: what `| tail -20` does to the output, not a second program.
 */
function pipesOnlyIntoReads(
  segments: readonly ShellSegment[],
  index: number,
  dir: string,
  checkout: string,
): boolean {
  const lead = segments[index];
  const later = segments.slice(index + 1);
  if (lead === undefined) return false;
  if (later.length === 0) return lead.separator === '';
  if (lead.separator !== '|') return false;
  return later.every((segment, at) => {
    if (segment.separator !== (at === later.length - 1 ? '' : '|')) return false;
    if (
      !segment.wordsCertain ||
      segment.nested.length > 0 ||
      segment.hereDocuments.length > 0 ||
      segment.dynamicWords.some(Boolean) ||
      !redirectionsAreSafe(segment, dir, checkout)
    )
      return false;
    const { words } = wordsWithoutRedirections(segment.words, segment.dynamicWords);
    const read = readCallOf(words);
    return read !== null && (read.operands === Operands.Text || read.targets.length === 0);
  });
}

/** The index of the first word from `from` that is no option (past the value of a valued one); -1 for none. */
function operandAt(
  words: readonly string[],
  from: number,
  valued: ReadonlySet<string> = NO_VALUED_OPTIONS,
): number {
  for (let at = from; at < words.length; at += 1) {
    const word = words[at] ?? '';
    if (word === '--') return -1;
    if (valued.has(word)) at += 1;
    else if (!word.startsWith('-')) return at;
  }
  return -1;
}

function makeKey(args: readonly string[], dynamic: readonly boolean[], dir: string): string | null {
  let makeDir = dir;
  const targets: string[] = [];
  for (let at = 0; at < args.length; at += 1) {
    const word = args[at] ?? '';
    if (dynamic[at] === true) return null;
    let into: string | undefined;
    if (word === '-C' || word === '--directory') {
      at += 1;
      if (dynamic[at] === true || args[at] === undefined) return null;
      into = args[at];
    } else if (word.startsWith('--directory=')) into = word.slice('--directory='.length);
    else if (word.startsWith('-C')) into = word.slice(2);
    if (into !== undefined) {
      const next = within(makeDir, into);
      if (next === null) return null;
      makeDir = next;
    } else if (word === '-j' && /^\d+$/.test(args[at + 1] ?? '')) at += 1;
    else if (MAKE_QUIET_OPTIONS.has(word) || /^-j\d+$/.test(word)) continue;
    else if (word.startsWith('-')) return null;
    else if (!word.includes('=')) targets.push(word);
  }
  return ['make', ...(makeDir === '' ? [] : ['-C', makeDir]), ...targets].join(' ');
}

/** `<runner> <word>`, the word being the script (or the binary `exec` runs) the call names. */
function runnerKey(
  runner: string,
  args: readonly string[],
  dynamic: readonly boolean[],
): string | null {
  const valued = VALUED_OPTIONS[runner] ?? NO_VALUED_OPTIONS;
  const first = operandAt(args, 0, valued);
  if (first < 0) return runner;
  if (dynamic[first] === true) return null;
  const word = args[first] ?? '';
  const wordAfter = (from: number): { readonly at: number } | null => {
    const at = operandAt(args, from, valued);
    return at >= 0 && dynamic[at] === true ? null : { at };
  };
  const script = (prefix: string, from: number): string | null => {
    const next = wordAfter(from);
    if (next === null) return null;
    return next.at < 0 ? prefix : `${prefix} ${args[next.at] ?? ''}`;
  };
  switch (runner) {
    case 'pnpm':
      if (word === 'run' || word === 'run-script') return script('pnpm', first + 1);
      if (word === 'exec') return script('pnpm exec', first + 1);
      return `pnpm ${word}`;
    case 'npm':
      if (NPM_RUNS.has(word)) return script('npm run', first + 1);
      if (NPM_SHORTCUTS.has(word)) return `npm run ${word}`;
      return `npm ${word}`;
    case 'bun':
      if (word === 'run') return script('bun run', first + 1);
      return `bun ${word}`;
    default:
      if (word === 'run') return script(runner, first + 1);
      return `${runner} ${word}`;
  }
}

function keyOf(
  program: string,
  args: readonly string[],
  dynamic: readonly boolean[],
  dir: string,
  checkout: string,
): string | null {
  if (MAKES.has(program)) return makeKey(args, dynamic, dir);
  if (INTERPRETERS.has(program)) {
    const [script] = args;
    if (script === undefined || script.startsWith('-') || dynamic[0] === true) return program;
    const path = repoPath(dir, script, checkout);
    return path === null || path === '' ? program : `${program} ${path}`;
  }
  if (program.includes('/')) {
    const path = repoPath(dir, program, checkout);
    return path === null || path === '' ? program : path;
  }
  if (Object.hasOwn(VALUED_OPTIONS, program)) return runnerKey(program, args, dynamic);
  const first = operandAt(args, 0);
  if (first < 0) return program;
  return dynamic[first] === true ? null : `${program} ${args[first] ?? ''}`;
}

/**
 * Names the program a shell call runs: a make target (with its folder), a repository script by its path, a
 * package runner's script, else the program and its first operand. It only picks which precedent the judge is
 * shown, never whether a call may run. Null where the call is not one program: a second command, a substitution,
 * a here-document, a redirect outside the checkout and the temp folder, a pipe into anything but the fast
 * path's reads, a tool that is not the shell, or a folder outside the checkout.
 */
export function programKey(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  checkout: string,
  cwd: string,
): string | null {
  const command = input['command'];
  if (toolName !== 'Bash' || typeof command !== 'string') return null;
  // A call with a field beyond its command and labels (the sandbox switched off) is no plain command.
  if (grantCallSummary(toolName, input) !== command) return null;
  const start = posix.relative(checkout, posix.normalize(cwd));
  if (start.startsWith('..') || posix.isAbsolute(start)) return null;
  const lead = leadingCommand(command, start, checkout);
  if (lead === null) return null;
  const { segments, index, dir } = lead;
  const leading = segments[index];
  if (leading === undefined) return null;
  if (!redirectionsAreSafe(leading, dir, checkout)) return null;
  if (!pipesOnlyIntoReads(segments, index, dir, checkout)) return null;
  const words = wordsWithoutRedirections([lead.program, ...lead.args], lead.dynamic);
  let at = 0;
  while (at < words.words.length) {
    const word = words.words[at] ?? '';
    if (word === 'env' && (words.words[at + 1] ?? '').startsWith('-')) return null;
    if (word !== 'env' && !ASSIGNMENT_WORD.test(word)) break;
    at += 1;
  }
  const [program, ...args] = words.words.slice(at);
  if (program === undefined || words.dynamic[at] === true) return null;
  const key = keyOf(program, args, words.dynamic.slice(at + 1), dir, checkout);
  return key !== null && ProgramKey.safeParse(key).success ? key : null;
}

/**
 * The repository path of the `package.json` that names a package runner key's script: the nearest one from
 * `cwd` up to the checkout. Null for any other key, a `cwd` outside the checkout, or no file.
 */
export function keyPackageFile(key: string, checkout: string, cwd: string): string | null {
  if (!PACKAGE_RUNNER_KEY.test(key)) return null;
  const inCheckout = (path: string): boolean => {
    const rel = relative(checkout, path);
    return !rel.startsWith('..') && !isAbsolute(rel);
  };
  let folder = cwd;
  while (inCheckout(folder)) {
    const file = join(folder, 'package.json');
    if (existsSync(file)) return relative(checkout, file).split(sep).join('/');
    if (folder === checkout) return null;
    const parent = dirname(folder);
    if (parent === folder) return null;
    folder = parent;
  }
  return null;
}
