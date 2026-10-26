import { splitCommand, stripCommandPrefixes, type ShellSegment } from '../guard';

/** Redirections that only discard or merge output; every other redirection can write or read a file. */
const HARMLESS_REDIRECTIONS = new Set(['2>&1', '>/dev/null', '2>/dev/null']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Wrapper flags that carry a command or a path, so the words after them no longer say what
 * runs. `*` marks a wrapper that is never plain.
 */
const UNSAFE_WRAPPER_FLAGS: ReadonlyMap<string, readonly string[]> = new Map([
  ['env', ['-S', '--split-string', '-C', '--chdir']],
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

function wrapperName(word: string): string | null {
  const name = word.replace(/^\\+/, '').split('/').pop() ?? '';
  return PASS_THROUGH_WRAPPERS.has(name) ? name : null;
}

function hasUnsafeFlag(name: string, flag: string): boolean {
  const unsafe = UNSAFE_WRAPPER_FLAGS.get(name) ?? [];
  return unsafe.some(
    (u) => flag === u || flag.startsWith(`${u}=`) || (!u.startsWith('--') && flag.startsWith(u)),
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
        i += VALUE_FLAGS.get(name)?.has(flag) === true ? 2 : 1;
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
  /** The command as the shell runs it, with wrappers and path prefixes removed. */
  readonly line: string;
  readonly words: string[];
  readonly separator: string;
}

/** The command's segments when every one is plain; null when any segment could do more than it says. */
export function plainSegments(command: string): PlainSegment[] | null {
  const segments = splitCommand(command);
  if (segments.length === 0 || !segments.every(isPlainSegment)) return null;
  return segments.map((s) => {
    const words = stripCommandPrefixes(s.words);
    return { line: words.join(' '), words, separator: s.separator };
  });
}
