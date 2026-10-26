import { isAbsolute, sep } from 'node:path';
import { expandBraces } from '../guard';

const MAX_PATTERN_LENGTH = 1024;
/** Characters every glob engine reads as themselves in a name. */
const LITERAL_CHARACTER = /^[A-Za-z0-9_\-. @+~%=,:]$/;
const LITERAL_SEGMENT = /^[A-Za-z0-9_\-. @+~%=,:]*$/;
const CLASS_MEMBER = /^[A-Za-z0-9_]$/;
const RANGE_GROUPS = [/^[a-z]$/, /^[A-Z]$/, /^[0-9]$/];

function isRange(from: string, to: string): boolean {
  return from <= to && RANGE_GROUPS.some((group) => group.test(from) && group.test(to));
}

/**
 * The length of the bracket class that opens at `start` when every member is a letter, digit or
 * `_`, or a range within one of `a-z`, `A-Z` and `0-9`; null for any other class. A class that is
 * not negated needs more than one member, since an engine reads a single member as a literal.
 */
function safeClassLength(segment: string, start: number): number | null {
  let index = start + 1;
  const negated = segment.charAt(index) === '!' || segment.charAt(index) === '^';
  if (negated) index += 1;
  let members = 0;
  while (index < segment.length && segment.charAt(index) !== ']') {
    const from = segment.charAt(index);
    const to = segment.charAt(index + 2);
    if (segment.charAt(index + 1) === '-' && to !== '' && to !== ']') {
      if (!isRange(from, to)) return null;
      members += 2;
      index += 3;
    } else {
      if (!CLASS_MEMBER.test(from)) return null;
      members += 1;
      index += 1;
    }
  }
  if (index >= segment.length || members === 0 || (!negated && members === 1)) return null;
  return index + 1 - start;
}

/**
 * Whether a segment after the literal prefix can only match names in the directory it is read
 * from: literal characters, `*`, `?` and safe classes, and never `..` itself. None of these can
 * spell `..`, an escape or a separator, whatever the engine does with them.
 */
function isSafeSegment(segment: string): boolean {
  if (segment === '..') return false;
  let index = 0;
  while (index < segment.length) {
    const character = segment.charAt(index);
    if (character === '*' || character === '?' || LITERAL_CHARACTER.test(character)) {
      index += 1;
      continue;
    }
    if (character !== '[') return false;
    const length = safeClassLength(segment, index);
    if (length === null) return false;
    index += length;
  }
  return true;
}

function underBase(base: string, literal: string): string {
  if (isAbsolute(literal)) return literal;
  return base === '.' ? literal : `${base}${sep}${literal}`;
}

/**
 * The directory one brace-free alternative is read from: its leading segments of literal
 * characters, joined onto `base`. Null when the pattern starts with a wildcard (`base` itself is
 * read). The root when any later segment is not a safe one.
 */
function alternativeBase(alternative: string, base: string): string | null {
  const segments = alternative.split('/');
  const wild = segments.findIndex((segment) => !LITERAL_SEGMENT.test(segment));
  if (wild === -1) return alternative === '' ? null : underBase(base, alternative);
  if (!segments.slice(wild).every(isSafeSegment)) return sep;
  if (wild === 0) return null;
  const prefix = segments.slice(0, wild).join('/');
  return prefix === '' ? sep : underBase(base, prefix);
}

/**
 * The directories a Glob pattern reads, joined onto `base`. Each brace alternative is judged by
 * its literal prefix only when everything after it is a known-safe form; any other pattern (a
 * backslash, an extglob, a class outside the safe set, a `..` after the prefix, a brace the
 * expander does not model, a pattern over 1024 characters) is judged as the root.
 */
export function globPatternBases(pattern: string, base: string): string[] {
  if (pattern.length > MAX_PATTERN_LENGTH) return [sep];
  const alternatives = expandBraces(pattern);
  if (alternatives === null) return [sep];
  const bases = alternatives.map((alternative) => alternativeBase(alternative, base));
  return [...new Set(bases.filter((prefix) => prefix !== null))];
}
