import { posix } from 'node:path';
import type { CommittedFile, CommittedReader } from '../folders';
import { redirectionSpan } from '../guard';
import {
  ASSIGNMENT_WORD,
  INTERPRETERS,
  leadingCommand,
  MAKE_QUIET_OPTIONS,
  MAKES,
  repoPath,
} from './leading-command';
import { MAKEFILE_NAMES, parseRules, within, withoutComments, type MakeRule } from './make-rules';

/** What a call runs, as committed on the base: a make target's rule, or a repository script whole. */
export type RunText =
  | {
      readonly kind: 'make';
      /** The Makefile's path from the repository root. */
      readonly makefile: string;
      readonly target: string;
      readonly prerequisites: readonly string[];
      /** The recipe as written, one leading tab off each line; variables are not expanded. */
      readonly recipe: string;
      /** The single-line assignments of the variables the recipe and prerequisites use, as written. */
      readonly variables: readonly string[];
    }
  | { readonly kind: 'script'; readonly path: string; readonly text: string };

export interface CallRuns {
  readonly runs: readonly RunText[];
  /** A bound (depth, reads or the total size) left out some of what the call runs. */
  readonly cut: boolean;
  /**
   * A file the walk read is changed in the checkout, or is new to it (`readCommitted` answers `differs` for
   * both): what runs is not the base's text, so no standing approval of its kind is shown to a judge.
   */
  readonly differs: boolean;
}

/** How many calls deep a make target or script is followed: a target, what it needs, what that runs. */
export const RUNS_MAX_DEPTH = 3;
/** The most repository files read for one call. */
export const RUNS_MAX_READS = 12;
/** A script larger than this is never shown, rather than shown in part. */
export const RUNS_MAX_SCRIPT_BYTES = 16 * 1024;
/** The most characters of runs shown for one call, as the judge reads them. */
export const RUNS_MAX_CHARS = 24_000;

const INCLUDE = /^(-?include|sinclude)\s+(.*)$/;
const VARIABLE_ASSIGNMENT =
  /^(?:(?:export|override)\s+)*([A-Za-z_][A-Za-z0-9_.-]*)\s*(?::::=|::=|:=|\?=|\+=|!=|=)/;
const VARIABLE_USE = /\$[({]([A-Za-z_][A-Za-z0-9_.-]*)/g;
const MAKE_VARIABLE = /\$[({]MAKE[)}]/g;

interface Makefile {
  readonly path: string;
  readonly rules: Map<string, MakeRule[]>;
  /** Each variable's single-line assignments, as written. */
  readonly variables: Map<string, string[]>;
}

function variablesOf(text: string): Map<string, string[]> {
  const variables = new Map<string, string[]>();
  for (const line of text.split('\n')) {
    if (line.startsWith('\t') || line.trimEnd().endsWith('\\')) continue;
    const name = VARIABLE_ASSIGNMENT.exec(line)?.[1];
    if (name !== undefined) variables.set(name, [...(variables.get(name) ?? []), line.trim()]);
  }
  return variables;
}

/** The assignments of the variables `text` uses, and of those their values use, in order of first use. */
function usedVariables(text: string, variables: Map<string, string[]>): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  const visit = (from: string): void => {
    for (const use of from.matchAll(VARIABLE_USE)) {
      const name = use[1] ?? '';
      const assignments = variables.get(name);
      if (seen.has(name) || assignments === undefined) continue;
      seen.add(name);
      lines.push(...assignments);
      for (const assignment of assignments) visit(assignment);
    }
  };
  visit(text);
  return lines;
}

/** A recipe's command lines: continuations joined, comments dropped, `@`, `-` and `+` off the front. */
function recipeCommands(recipe: string): string[] {
  return withoutComments(recipe)
    .replace(/\\\n/g, ' ')
    .split('\n')
    .map((line) => line.replace(/^\t/, '').replace(/^[\s@+-]+/, ''))
    .filter((line) => line !== '');
}

/**
 * The committed text of the make targets and repository scripts a shell command runs, read through `read` (the
 * base's text where the checkout holds it unchanged): `make [-C dir] target` and what the target needs, the
 * `$(MAKE)` and `make` calls and scripts on its recipe lines; a script named by a path (`./x`, `.agents/bin/x`, an
 * absolute path in the checkout) or right after an interpreter (`python3 x.py`), shown whole and not followed.
 * Only the first command of a line is followed, past the `cd`s that certainly move it: a command before it could
 * write the file or change the shell, so the text would not be what runs. A command that holds a substitution,
 * whose words the shell fills in, that starts with `VAR=value`, or a make option that may change what it reads,
 * shows nothing. Bounded by `RUNS_MAX_DEPTH`, `RUNS_MAX_READS`, `RUNS_MAX_SCRIPT_BYTES` and `RUNS_MAX_CHARS`.
 * `cwd` outside `checkout` shows nothing.
 */
export async function callRuns(
  command: string,
  cwd: string,
  checkout: string,
  read: CommittedReader,
): Promise<CallRuns> {
  const start = posix.relative(checkout, posix.normalize(cwd));
  if (start.startsWith('..') || posix.isAbsolute(start))
    return { runs: [], cut: false, differs: false };
  const runs: RunText[] = [];
  let chars = 0;
  let cut = false;
  let differs = false;
  const seen = new Set<string>();
  const files = new Map<string, CommittedFile>();
  const makefiles = new Map<string, Makefile | null>();

  const readOnce = async (path: string): Promise<CommittedFile> => {
    const known = files.get(path);
    if (known !== undefined) return known;
    if (files.size >= RUNS_MAX_READS) {
      cut = true;
      return { kind: 'differs' };
    }
    const file = await read(path);
    files.set(path, file);
    return file;
  };

  const add = (run: RunText): void => {
    const size = JSON.stringify(run).length;
    if (chars + size > RUNS_MAX_CHARS) {
      cut = true;
      return;
    }
    chars += size;
    runs.push(run);
  };

  /** The text of a Makefile and the files it includes, when each is committed unchanged; else null. */
  async function withIncludes(
    dir: string,
    text: string,
    included: Set<string>,
  ): Promise<string | null> {
    const parts = [text];
    for (const line of text.split('\n')) {
      const include = INCLUDE.exec(line.replace(/#.*$/, '').trimEnd());
      if (include === null) continue;
      const optional = include[1] !== 'include';
      for (const word of (include[2] ?? '').split(/\s+/).filter((w) => w !== '')) {
        if (/[$*?[`]/.test(word)) return null;
        const path = within(dir, word);
        if (path === null) return null;
        if (included.has(path)) continue;
        included.add(path);
        const file = await readOnce(path);
        if (file.kind === 'absent' && optional) continue;
        if (file.kind === 'differs') differs = true;
        if (file.kind !== 'same') return null;
        const nested = await withIncludes(dir, file.text, included);
        if (nested === null) return null;
        parts.push(nested);
      }
    }
    return parts.join('\n');
  }

  /** The Makefile make reads in `dir`: the first of its names there, which must be committed unchanged. */
  async function makefileIn(dir: string): Promise<Makefile | null> {
    if (makefiles.has(dir)) return makefiles.get(dir) ?? null;
    let found: Makefile | null = null;
    for (const [i, name] of MAKEFILE_NAMES.entries()) {
      const path = within(dir, name);
      if (path === null) break;
      const file = await readOnce(path);
      if (file.kind === 'absent') continue;
      // Where the folder holds only `Makefile`, make's earlier `makefile` opens that entry or nothing,
      // by the file system. Either way `Makefile` is what it reads.
      if (
        file.kind === 'differs' &&
        file.entry !== undefined &&
        MAKEFILE_NAMES.slice(i + 1).some((later) => later === file.entry)
      )
        continue;
      if (file.kind === 'differs') differs = true;
      if (file.kind === 'same') {
        const text = await withIncludes(dir, file.text, new Set([path]));
        if (text !== null) found = { path, rules: parseRules(text), variables: variablesOf(text) };
      }
      break;
    }
    makefiles.set(dir, found);
    return found;
  }

  async function target(makefile: Makefile, dir: string, name: string, depth: number) {
    if (depth > RUNS_MAX_DEPTH) {
      cut = true;
      return;
    }
    const key = `target:${makefile.path}:${name}`;
    const rules = makefile.rules.get(name) ?? [];
    if (seen.has(key) || rules.length === 0) return;
    seen.add(key);
    const prerequisites = [...new Set(rules.flatMap((rule) => rule.prerequisites))];
    const recipe = rules
      .map((rule) => rule.recipe.replace(/^\t/gm, ''))
      .filter((r) => r !== '')
      .join('\n');
    add({
      kind: 'make',
      makefile: makefile.path,
      target: name,
      prerequisites,
      recipe,
      variables: usedVariables(`${prerequisites.join(' ')}\n${recipe}`, makefile.variables),
    });
    for (const needed of prerequisites) await target(makefile, dir, needed, depth + 1);
    for (const rule of rules)
      for (const line of recipeCommands(rule.recipe))
        await walk(line.replace(MAKE_VARIABLE, 'make'), dir, depth);
  }

  async function make(
    args: readonly string[],
    dynamic: readonly boolean[],
    dir: string,
    depth: number,
  ) {
    let makeDir = dir;
    const targets: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const word = args[i] ?? '';
      if (dynamic[i] === true) return;
      const redirection = redirectionSpan(args, i);
      if (redirection > 0) {
        if (redirection === 2 && dynamic[i + 1] === true) return;
        i += redirection - 1;
        continue;
      }
      if (/[<>]/.test(word)) return;
      let into: string | undefined;
      if (word === '-C' || word === '--directory') {
        i += 1;
        if (dynamic[i] === true || args[i] === undefined) return;
        into = args[i];
      } else if (word.startsWith('--directory=')) into = word.slice('--directory='.length);
      else if (word.startsWith('-C')) into = word.slice(2);
      if (into !== undefined) {
        const next = within(makeDir, into);
        if (next === null) return;
        makeDir = next;
      } else if (word === '-j' && /^\d+$/.test(args[i + 1] ?? '')) i += 1;
      else if (MAKE_QUIET_OPTIONS.has(word) || /^-j\d+$/.test(word)) continue;
      else if (word.startsWith('-')) return;
      else if (!word.includes('=')) targets.push(word);
    }
    if (targets.length === 0) return;
    const makefile = await makefileIn(makeDir);
    if (makefile === null) return;
    for (const name of targets) await target(makefile, makeDir, name, depth + 1);
  }

  // A script is shown and not followed, so it is no level of its own.
  async function script(path: string | null) {
    if (path === null || path === '') return;
    const key = `script:${path}`;
    if (seen.has(key)) return;
    seen.add(key);
    const file = await readOnce(path);
    if (file.kind === 'differs') differs = true;
    if (file.kind !== 'same' || Buffer.byteLength(file.text) > RUNS_MAX_SCRIPT_BYTES) return;
    add({ kind: 'script', path, text: file.text });
  }

  /**
   * Follows one shell command line run in `dir`, `depth` calls below the builder's call: the first command of
   * the line, past the `cd`s that certainly move it. Anything else that runs first may write the file, or change
   * the shell's functions and environment, so what comes after it is not followed.
   */
  async function walk(line: string, from: string, depth: number) {
    const lead = leadingCommand(line, from, checkout);
    if (lead === null) return;
    const { program, args, dynamic, dir } = lead;
    if (MAKES.has(program)) await make(args, dynamic.slice(1), dir, depth);
    else if (INTERPRETERS.has(program)) {
      const [path] = args;
      if (path !== undefined && !path.startsWith('-') && dynamic[1] !== true)
        await script(repoPath(dir, path, checkout));
    } else if (program.includes('/') && !ASSIGNMENT_WORD.test(program))
      await script(repoPath(dir, program, checkout));
  }

  await walk(command, start, 0);
  return { runs, cut, differs };
}
