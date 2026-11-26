import { posix } from 'node:path';
import { leadingWords, parseShell, type ShellSegment } from '../guard';
import { within } from './make-rules';

/** Programs that run the file named right after them. */
export const INTERPRETERS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'python',
  'python3',
  'node',
  'ruby',
  'perl',
]);
export const MAKES: ReadonlySet<string> = new Set(['make', 'gmake']);
/** make's options that change neither which Makefile nor which targets it reads. */
export const MAKE_QUIET_OPTIONS: ReadonlySet<string> = new Set([
  '-s',
  '-n',
  '-k',
  '-B',
  '-j',
  '--silent',
  '--dry-run',
  '--no-print-directory',
]);
export const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/;
/**
 * A `cd` the walk follows, at the start of the text: `cd`, one bare word that is no option, and a separator the
 * next command waits on. After `;` or a newline the next command runs even when the `cd` failed, so the word must
 * be all the shell's `cd` gets: no quote, bracket, expansion or second argument.
 */
const CD_THEN = /^[ \t]*cd[ \t]+([A-Za-z0-9_./@%+,:][A-Za-z0-9_./@%+,:-]*)[ \t]*(&&|;|\n)/;
/** A here-document operator (`<<`, `<<-`), not a here-string (`<<<`). */
const HERE_DOCUMENT = /(?<!<)<<(?!<)/;

/** A path the call names, from the repository root: relative to `dir`, or absolute inside the checkout. */
export function repoPath(dir: string, word: string, checkout: string): string | null {
  if (word.startsWith('/')) {
    const relative = posix.relative(checkout, posix.normalize(word));
    return relative === '' || relative.startsWith('..') || posix.isAbsolute(relative)
      ? null
      : relative;
  }
  return within(dir, word);
}

/** The command a shell line starts with, past the `cd`s that certainly move it. */
export interface LeadingCommand {
  readonly program: string;
  readonly args: readonly string[];
  /** Parallel to `[program, ...args]`: the shell fills in part of the word at run time. */
  readonly dynamic: readonly boolean[];
  /** The folder it runs in, from the repository root, after the `cd`s. */
  readonly dir: string;
  /** Every segment of the line, and which one is the leading command. */
  readonly segments: readonly ShellSegment[];
  readonly index: number;
}

/**
 * The first command of a shell line run in `from` (a folder from the repository root), past the `cd`s that
 * certainly move it; null where the line's order is not certain: a loop, a substitution, a here-document, a `cd`
 * that may not move what follows, or words the shell fills in. Anything else that runs first may write the file
 * or change the shell, so a line whose first command is not this one is not followed.
 */
export function leadingCommand(
  line: string,
  from: string,
  checkout: string,
): LeadingCommand | null {
  const parsed = parseShell(line);
  if (!parsed.certain) return null;
  let dir = from;
  // The line's text not yet accounted for by a followed `cd`.
  let rest = line;
  for (const [index, segment] of parsed.segments.entries()) {
    // A command whose words the parser dropped (`''`) still runs, and takes its separator with it.
    if (segment.words.length === 0) return null;
    const lead = leadingWords(segment.words);
    const offset = segment.words.length - lead.command.length;
    const dynamic = segment.dynamicWords.slice(offset);
    const [program = '', ...args] = lead.command;
    // A substitution or here-document of the segment runs before its command. A here-document that never
    // closes has no body the parser kept, so its operator among the words counts too.
    if (
      !segment.wordsCertain ||
      lead.outOfOrder ||
      segment.nested.length > 0 ||
      segment.hereDocuments.length > 0 ||
      segment.words.some((word) => HERE_DOCUMENT.test(word))
    )
      return null;
    if (program === 'cd') {
      // A `cd` moves what follows only as a plain command of this shell that the next one waits on: not in a
      // conditional's body, a group, a subshell, a pipeline or the background, and not where `||` runs the
      // next. The line's own text decides, since the parser keeps no trace of a bracket or an empty word.
      const plain = CD_THEN.exec(rest);
      if (
        plain === null ||
        offset !== 0 ||
        args.length !== 1 ||
        args[0] !== plain[1] ||
        segment.separator !== plain[2]
      )
        return null;
      const next = repoPath(dir, plain[1] ?? '', checkout);
      if (next === null) return null;
      dir = next;
      rest = rest.slice(plain[0].length);
      continue;
    }
    // After a `cd`, the command followed is the text right after it.
    if (rest !== line && !rest.trimStart().startsWith(segment.raw)) return null;
    if (lead.hiddenByRedirection || dynamic[0] === true) return null;
    return { program, args, dynamic, dir, segments: parsed.segments, index };
  }
  return null;
}
