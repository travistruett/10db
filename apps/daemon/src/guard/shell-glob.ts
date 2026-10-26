import { readdirSync, type Dirent } from 'node:fs';
import { isAbsolute, matchesGlob, resolve, sep } from 'node:path';
import { expandBraces } from './braces';

const MAX_MATCHES = 1000;
const MAX_ENTRIES = 10000;
/** Characters that make a segment a pattern once braces are expanded and escapes dropped. */
const MAGIC = /[*?[\]]/;

/** An expansion that grew past the bounds the guard follows. */
class ShellGlobLimitError extends Error {
  override readonly name = 'ShellGlobLimitError';
}

interface Budget {
  entries: number;
}

function isAbsent(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

/** The entries of a directory; none when it does not exist. Any other failure throws. */
function entriesOf(directory: string, budget: Budget): Dirent[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (isAbsent(error)) return [];
    throw error;
  }
  budget.entries += entries.length;
  if (budget.entries > MAX_ENTRIES) throw new ShellGlobLimitError('too many entries to examine');
  return entries;
}

/** Whether `name` matches one segment of a pattern, a leading `.` matched like any character. */
function segmentMatches(name: string, segment: string): boolean {
  // The engine never lets a wildcard match a leading `.`; the same letter in front of both
  // makes the dot an ordinary character, as a shell with dotglob set treats it.
  return matchesGlob(`a${name}`, `a${segment}`);
}

/**
 * The names a segment is matched against in `directory`. A directory listing never holds `.` and
 * `..`, but a shell matches them with a segment that opens with a literal `.` (`.?`, `.*`, `.[.]`
 * all reach `..`), so for such a segment they come first.
 */
function candidateNames(directory: string, segment: string, budget: Budget): string[] {
  const names = entriesOf(directory, budget).map((entry) => entry.name);
  return segment.startsWith('.') ? ['.', '..', ...names] : names;
}

function under(parent: string, name: string): string {
  if (parent === '') return name;
  return parent.endsWith(sep) ? `${parent}${name}` : `${parent}${sep}${name}`;
}

/** `parent` and every path below it, without following links, for a `**` segment. */
function everythingUnder(parent: string, cwd: string, budget: Budget): string[] {
  const found = [parent];
  const directories = [parent];
  for (let next = directories.pop(); next !== undefined; next = directories.pop()) {
    for (const entry of entriesOf(resolve(cwd, next === '' ? '.' : next), budget)) {
      const path = under(next, entry.name);
      found.push(path);
      if (entry.isDirectory()) directories.push(path);
    }
  }
  return found;
}

function expandAlternative(alternative: string, cwd: string, budget: Budget): string[] {
  let paths = [isAbsolute(alternative) ? sep : ''];
  for (const segment of alternative.split('/')) {
    if (segment === '') continue;
    if (!MAGIC.test(segment)) {
      paths = paths.map((parent) => under(parent, segment));
      continue;
    }
    const next: string[] = [];
    for (const parent of paths) {
      if (segment === '**') {
        next.push(...everythingUnder(parent, cwd, budget));
      } else {
        const directory = resolve(cwd, parent === '' ? '.' : parent);
        for (const name of candidateNames(directory, segment, budget)) {
          if (segmentMatches(name, segment)) next.push(under(parent, name));
        }
      }
      if (next.length > MAX_MATCHES) throw new ShellGlobLimitError('too many matches');
    }
    paths = next;
  }
  return paths;
}

/**
 * The paths a shell could expand one unquoted word to in `cwd`, as a superset: escapes are
 * dropped (so an escaped wildcard counts as a wildcard), braces are expanded, a wildcard matches
 * a leading `.`, a segment opening with `.` can match `.` and `..`, and `**` reaches every depth. Null when the word cannot be followed within
 * bounds: a brace the expander does not model, an unreadable directory, more than 1000 matches
 * or more than 10000 directory entries examined.
 */
export function shellGlobMatches(word: string, cwd: string): string[] | null {
  const alternatives = expandBraces(word.replace(/\\(.?)/gsu, '$1'));
  if (alternatives === null) return null;
  const budget: Budget = { entries: 0 };
  const matches = new Set<string>();
  try {
    for (const alternative of alternatives) {
      for (const match of expandAlternative(alternative, cwd, budget)) {
        if (match !== '') matches.add(match);
      }
      if (matches.size > MAX_MATCHES) return null;
    }
  } catch {
    return null;
  }
  return [...matches];
}
