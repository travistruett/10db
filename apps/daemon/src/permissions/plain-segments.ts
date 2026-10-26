import {
  flagSpan,
  isUnknownEnvLongFlag,
  parseShell,
  splitCommand,
  stripCommandPrefixes,
  type ShellSegment,
} from '../guard';

/** Redirections that only discard or merge output; every other redirection can write or read a file. */
const HARMLESS_REDIRECTIONS = new Set(['2>&1', '>/dev/null', '2>/dev/null']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Wrapper flags that carry a command or a path, so the words after them no longer say what
 * runs: env's `-P` sets the path its command is looked up in. `*` marks a wrapper that is never
 * plain.
 */
const UNSAFE_WRAPPER_FLAGS: ReadonlyMap<string, readonly string[]> = new Map([
  ['env', ['-S', '--split-string', '-C', '--chdir', '-P']],
  ['time', ['-o', '--output']],
  ['xargs', ['*']],
]);
const PASS_THROUGH_WRAPPERS = new Set(['env', 'command', 'nohup', 'time', 'exec', 'xargs']);
/** The flags of a pass-through wrapper that consume the following word. */
const VALUE_FLAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['env', new Set(['-u', '--unset'])],
  ['time', new Set(['-f', '--format'])],
  ['exec', new Set(['-a'])],
]);

const NO_VALUE_FLAGS: ReadonlySet<string> = new Set();

function wrapperName(word: string): string | null {
  const name = word.replace(/^\\+/, '').split('/').pop() ?? '';
  return PASS_THROUGH_WRAPPERS.has(name) ? name : null;
}

/**
 * The letters of a short-flag cluster up to and including its first that takes a value, which
 * takes the rest of the word: `-iP/tmp/x` is `-i` and `-P`, while `-uP` unsets a variable named P.
 */
function clusterLetters(name: string, flag: string): string[] {
  if (flag.startsWith('--')) return [];
  const valued = VALUE_FLAGS.get(name) ?? NO_VALUE_FLAGS;
  const unsafe = UNSAFE_WRAPPER_FLAGS.get(name) ?? [];
  const letters: string[] = [];
  for (const letter of flag.slice(1)) {
    letters.push(letter);
    if (valued.has(`-${letter}`) || unsafe.includes(`-${letter}`)) break;
  }
  return letters;
}

/** A long flag as written, or abbreviated as GNU tools allow: `--split=x` is `--split-string=x`. */
function namesLongFlag(flag: string, long: string): boolean {
  const name = flag.split('=')[0] ?? flag;
  return name.length > 2 && long.startsWith(name);
}

function hasUnsafeFlag(name: string, flag: string): boolean {
  // An abbreviated env option may take the next word as its value, so what runs is unknown.
  if (name === 'env' && isUnknownEnvLongFlag(flag)) return true;
  const unsafe = UNSAFE_WRAPPER_FLAGS.get(name) ?? [];
  const letters = clusterLetters(name, flag);
  return unsafe.some((u) =>
    u.startsWith('--')
      ? flag.startsWith('--') && namesLongFlag(flag, u)
      : letters.includes(u.slice(1)),
  );
}

function hasShellExpansion(words: readonly string[]): boolean {
  return words.some((w) => w.includes('$') || w.includes('`'));
}

function hasRedirection(words: readonly string[]): boolean {
  return words.some((w) => /[<>]/.test(w) && !HARMLESS_REDIRECTIONS.has(w));
}

interface PrefixFacts {
  /** A wrapper flag carries a command or a path. */
  readonly unsafeWrapper: boolean;
  /** A `NAME=value` assignment precedes the command, possibly after a wrapper. */
  readonly assignment: boolean;
}

/** Inspects the assignments and wrappers that precede the command. */
function prefixFacts(words: readonly string[]): PrefixFacts {
  let assignment = false;
  let i = 0;
  while (i < words.length) {
    const word = words[i] ?? '';
    const name = wrapperName(word);
    if (ASSIGNMENT.test(word)) {
      assignment = true;
      i += 1;
    } else if (name !== null) {
      i += 1;
      if (UNSAFE_WRAPPER_FLAGS.get(name)?.includes('*') === true)
        return { unsafeWrapper: true, assignment };
      while (i < words.length && (words[i] ?? '').startsWith('-')) {
        const flag = words[i] ?? '';
        if (hasUnsafeFlag(name, flag)) return { unsafeWrapper: true, assignment };
        // Skipped as the guard skips it, so an assignment after `env -iu NAME` is still seen.
        i += flagSpan(flag, VALUE_FLAGS.get(name) ?? NO_VALUE_FLAGS);
      }
    } else {
      break;
    }
  }
  return { unsafeWrapper: false, assignment };
}

/** The segment has no substitution, expansion, redirection or wrapper that changes what it does. */
export function isLiteralSegment(segment: ShellSegment): boolean {
  return (
    !hasShellExpansion(segment.words) &&
    !hasRedirection(segment.words) &&
    !prefixFacts(segment.words).unsafeWrapper
  );
}

/** The segment is literal and runs the command itself, with no assignment in front. */
export function isPlainSegment(segment: ShellSegment): boolean {
  return isLiteralSegment(segment) && !prefixFacts(segment.words).assignment;
}

export interface PlainSegment {
  /** The command as the shell runs it, with wrappers removed and the program as it was written. */
  readonly line: string;
  /** The words the matcher compares: an escaped space or a quoted string stays one word. */
  readonly words: string[];
  readonly separator: string;
}

/**
 * The command's segments when every one is plain; null when any segment could do more than it says.
 * A command the scanner cannot parse with certainty is never plain, so it matches no stored rule.
 */
export function plainSegments(command: string): PlainSegment[] | null {
  if (!parseShell(command).certain) return null;
  const segments = splitCommand(command);
  if (segments.length === 0 || !segments.every(isPlainSegment)) return null;
  return segments.map((s) => {
    const words = stripCommandPrefixes(s.words, { keepCommandPath: true });
    return { line: words.join(' '), words, separator: s.separator };
  });
}
