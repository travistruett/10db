import { parseShell, type ShellSegment } from '../guard';

/**
 * Reads the command of a Monitor call: a lane waits on the output of a command it started in the
 * background with `until [ -s <file> ]; do sleep 2; done`, `until grep -q … <file>`, or a `grep`,
 * `tail` or `cat` of the file. Only a small grammar is read, and a command outside it is not one
 * this module vouches for: a program from the list below, plain words, and no expansion, nested
 * script, background job or redirection but `2>&1`, `>/dev/null` and `2>/dev/null`. Every file the
 * command names must pass `isOwnFile`, and every program that reads names at least one, unless a
 * pipe feeds it. So the command can only read the files `isOwnFile` accepts and write nothing.
 */

/** Words that start a command inside a loop or a condition. */
const LEADING = new Set(['until', 'while', 'if', 'then', 'else', 'elif', 'do', '!']);
/** Words that close a compound command and run nothing. */
const CLOSING = new Set(['done', 'fi']);
/** Operators that may end a segment. `&` (a background job) and parentheses may not. */
const SEPARATORS = new Set(['', ';', '&&', '||', '|', '\n']);
const QUIET_REDIRECTIONS = new Set(['2>&1', '>/dev/null', '2>/dev/null']);
const NUMBER = /^\d+(?:\.\d+)?$/;
const SIGNED_NUMBER = /^[+-]?\d+$/;

/** Test operators that only look at a file. */
const TEST_FLAGS = new Set(['!', '-s', '-f', '-e', '-r']);
/** `grep` options that neither read another file nor take a value: quiet, counts, matching modes. */
const GREP_FLAGS = /^-[qEFGicnvwxsHhoaI]+$/;
const CAT_FLAGS = /^-[nbsvet]+$/;
const WC_FLAGS = /^-[lwcmL]+$/;
const TAIL_FLAGS = /^-(?:[fFqv]+|[0-9]+)$/;
/** `-n` and `-c` take a count, attached or as the next word. */
const COUNT_FLAG = /^-([nc])(.*)$/;

/** Everything a segment's program needs to be judged. */
interface Reader {
  readonly isOwnFile: (path: string) => boolean;
  /** A pipe feeds the segment's standard input. */
  readonly piped: boolean;
}

/** True when every path is an accepted file and, unless a pipe feeds the program, there is one. */
function filesOk(files: readonly string[], reader: Reader): boolean {
  if (files.length === 0) return reader.piped;
  return files.every((file) => reader.isOwnFile(file));
}

function testReads(args: readonly string[], reader: Reader, bracket: boolean): boolean {
  let rest = args;
  if (bracket) {
    if (args[args.length - 1] !== ']') return false;
    rest = args.slice(0, -1);
  }
  return rest.every((word) => TEST_FLAGS.has(word) || reader.isOwnFile(word));
}

function grepReads(args: readonly string[], reader: Reader): boolean {
  let at = 0;
  while (at < args.length && (args[at] ?? '').startsWith('-') && args[at] !== '--') {
    if (!GREP_FLAGS.test(args[at] ?? '')) return false;
    at += 1;
  }
  if (args[at] === '--') at += 1;
  // The first word left is the pattern; the rest are files.
  return at < args.length && filesOk(args.slice(at + 1), reader);
}

/** `head` and `tail`: options with a count, then files. */
function headTailReads(args: readonly string[], reader: Reader, flags: RegExp | null): boolean {
  const files: string[] = [];
  for (let at = 0; at < args.length; at += 1) {
    const word = args[at] ?? '';
    if (!word.startsWith('-')) {
      files.push(word);
      continue;
    }
    const count = COUNT_FLAG.exec(word);
    if (count !== null) {
      let value = count[2];
      if (value === '') {
        at += 1;
        value = args[at];
      }
      if (!SIGNED_NUMBER.test(value ?? '')) return false;
    } else if (!flags?.test(word)) {
      return false;
    }
  }
  return filesOk(files, reader);
}

function plainReads(args: readonly string[], reader: Reader, flags: RegExp): boolean {
  const files = args.filter((word) => !word.startsWith('-'));
  const options = args.filter((word) => word.startsWith('-'));
  return options.every((word) => flags.test(word)) && filesOk(files, reader);
}

/** Whether a program, with its arguments, only reads files the reader accepts. */
function programReads(program: string, args: readonly string[], reader: Reader): boolean {
  switch (program) {
    case '[':
      return testReads(args, reader, true);
    case 'test':
      return testReads(args, reader, false);
    case 'grep':
      return grepReads(args, reader);
    case 'cat':
      return plainReads(args, reader, CAT_FLAGS);
    case 'wc':
      return plainReads(args, reader, WC_FLAGS);
    case 'head':
      return headTailReads(args, reader, null);
    case 'tail':
      return headTailReads(args, reader, TAIL_FLAGS);
    case 'sleep':
      return args.length === 1 && NUMBER.test(args[0] ?? '');
    case 'echo':
      return true;
    case 'true':
    case 'false':
    case ':':
      return args.length === 0;
    default:
      return false;
  }
}

/** Whether the text uses an expansion, substitution or escape the scan cannot read, outside single quotes. */
function expandsOutsideSingleQuotes(command: string): boolean {
  let single = false;
  for (const ch of command) {
    if (ch === "'") single = !single;
    else if (!single && (ch === '$' || ch === '`' || ch === '\\')) return true;
  }
  return false;
}

function segmentReads(
  segment: ShellSegment,
  piped: boolean,
  isOwnFile: (path: string) => boolean,
): boolean {
  if (
    segment.nested.length > 0 ||
    segment.hereDocuments.length > 0 ||
    segment.processSubstitution ||
    segment.subshells.length > 0 ||
    !segment.wordsCertain ||
    !segment.bracesCertain ||
    !SEPARATORS.has(segment.separator)
  ) {
    return false;
  }
  let words: string[] = [];
  for (const [at, word] of segment.words.entries()) {
    if (/[<>]/.test(word)) {
      if (!QUIET_REDIRECTIONS.has(word)) return false;
      continue;
    }
    // Only the test brackets may look like a glob; any other word with an expansion or glob is unread.
    if (segment.singleWords[at] !== true && word !== '[' && word !== ']') return false;
    words.push(word);
  }
  while (words.length > 0 && LEADING.has(words[0] ?? '')) words = words.slice(1);
  const [program, ...args] = words;
  if (program === undefined) return segment.words.length > 0;
  if (CLOSING.has(program)) return args.length === 0;
  return programReads(program, args, { isOwnFile, piped });
}

/**
 * Whether a Monitor command only waits on and reads files that `isOwnFile` accepts. False for
 * anything the grammar above does not cover; the caller then asks a person.
 */
export function readsOnlyOwnFiles(command: string, isOwnFile: (path: string) => boolean): boolean {
  if (expandsOutsideSingleQuotes(command)) return false;
  const parsed = parseShell(command);
  if (!parsed.certain || parsed.segments.length === 0) return false;
  let piped = false;
  for (const segment of parsed.segments) {
    if (!segmentReads(segment, piped, isOwnFile)) return false;
    piped = segment.separator === '|';
  }
  return true;
}
