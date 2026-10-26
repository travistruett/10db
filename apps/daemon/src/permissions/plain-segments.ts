import { parseShell, splitCommand, stripCommandPrefixes, type ShellSegment } from '../guard';

/** Redirections that only discard or merge output; every other redirection can write or read a file. */
const HARMLESS_REDIRECTIONS = new Set(['2>&1', '>/dev/null', '2>/dev/null']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

interface WrapperFlags {
  /** Flags that stand alone. */
  readonly bare: ReadonlySet<string>;
  /** Flags that take a value: the next word, attached to a short one (`-uNAME`) or after `=` on a long one. */
  readonly valued: ReadonlySet<string>;
}
const flags = (bare: readonly string[], valued: readonly string[] = []): WrapperFlags => ({
  bare: new Set(bare),
  valued: new Set(valued),
});

/**
 * The pass-through wrappers and the only flags each may carry in a plain segment, spelled exactly.
 * Any other flag word makes the segment not plain: an unknown letter, a cluster, an abbreviated or
 * unknown long option, or a flag that names a command or a path (env's `-S`, `-C` and `-P`, time's
 * `-o`), after which the words no longer say what runs. Null marks a wrapper that is never plain.
 */
const WRAPPER_FLAGS: ReadonlyMap<string, WrapperFlags | null> = new Map([
  [
    'env',
    flags(['-i', '-0', '-v', '--ignore-environment', '--null', '--debug'], ['-u', '--unset']),
  ],
  ['command', flags(['-p', '-v', '-V'])],
  ['nohup', flags([])],
  [
    'time',
    flags(
      ['-p', '-l', '-h', '-a', '-v', '--portability', '--verbose', '--append', '--quiet'],
      ['-f', '--format'],
    ),
  ],
  ['exec', flags(['-c', '-l'], ['-a'])],
  ['xargs', null],
]);

function wrapperName(word: string): string | null {
  const name = word.replace(/^\\+/, '').split('/').pop() ?? '';
  return WRAPPER_FLAGS.has(name) ? name : null;
}

/** How many words a wrapper's flag takes, or null when it is not one of the wrapper's exact flags. */
function plainFlagSpan(known: WrapperFlags, flag: string): 1 | 2 | null {
  if (known.bare.has(flag)) return 1;
  if (known.valued.has(flag)) return 2;
  for (const valued of known.valued) {
    const attached = valued.startsWith('--')
      ? flag.startsWith(`${valued}=`)
      : flag.startsWith(valued) && flag.length > valued.length;
    if (attached) return 1;
  }
  return null;
}

function hasShellExpansion(words: readonly string[]): boolean {
  return words.some((w) => w.includes('$') || w.includes('`'));
}

function hasRedirection(words: readonly string[]): boolean {
  return words.some((w) => /[<>]/.test(w) && !HARMLESS_REDIRECTIONS.has(w));
}

interface PrefixFacts {
  /** A wrapper carries a flag outside its exact flags, or is never plain. */
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
      const known = WRAPPER_FLAGS.get(name);
      if (!known) return { unsafeWrapper: true, assignment };
      while (i < words.length && (words[i] ?? '').startsWith('-')) {
        const span = plainFlagSpan(known, words[i] ?? '');
        if (span === null) return { unsafeWrapper: true, assignment };
        i += span;
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
