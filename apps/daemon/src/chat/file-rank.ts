import { PROJECT_FILES_MAX, type ProjectFileMatchDto } from '@10db/contracts';

// Sessions spec §11: the `@` list. The query is text, never a pattern: its characters appear in the
// path in order, case-insensitively. A match in the file name ranks before one in its folders, a
// match in one run before a scattered one, then the shorter path, then the alphabet. Paths and the
// query are compared in NFC, so a name APFS keeps decomposed still matches as typed.

type Range = [number, number];

interface Ranked {
  readonly path: string;
  readonly inName: boolean;
  readonly runs: number;
  readonly matches: Range[];
}

interface Char {
  readonly c: string;
  readonly at: number;
  readonly end: number;
}

/** The path's characters folded for comparison, each with its UTF-16 span in the path. */
function charsOf(path: string): Char[] {
  const out: Char[] = [];
  let at = 0;
  for (const c of path) {
    out.push({ c: c.toLocaleLowerCase('en'), at, end: at + c.length });
    at += c.length;
  }
  return out;
}

/** Adjacent spans as one range. */
function merge(spans: readonly Char[]): Range[] {
  const ranges: Range[] = [];
  for (const span of spans) {
    const last = ranges.at(-1);
    if (last?.[1] === span.at) last[1] = span.end;
    else ranges.push([span.at, span.end]);
  }
  return ranges;
}

/** Where the query's characters fall among `chars`: one run where there is one, else the first in order. */
function hits(chars: readonly Char[], query: readonly string[]): Char[] | null {
  for (let i = 0; i + query.length <= chars.length; i++)
    if (query.every((q, j) => chars[i + j]?.c === q)) return chars.slice(i, i + query.length);
  const found: Char[] = [];
  let j = 0;
  for (const char of chars) {
    if (j < query.length && char.c === query[j]) {
      found.push(char);
      j++;
    }
  }
  return j === query.length ? found : null;
}

function rankOne(path: string, query: readonly string[]): Ranked | null {
  const chars = charsOf(path);
  const nameAt = path.lastIndexOf('/') + 1;
  const inName = hits(
    chars.filter((c) => c.at >= nameAt),
    query,
  );
  const found = inName ?? hits(chars, query);
  if (found === null) return null;
  const matches = merge(found);
  return { path, inName: inName !== null, runs: matches.length, matches };
}

const alphabetical = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function rankFiles(
  paths: readonly string[],
  query: string,
  limit: number = PROJECT_FILES_MAX,
): ProjectFileMatchDto[] {
  const all = paths.map((p) => p.normalize('NFC'));
  const q = Array.from(query.normalize('NFC'), (c) => c.toLocaleLowerCase('en'));
  if (q.length === 0)
    return [...all]
      .sort(alphabetical)
      .slice(0, limit)
      .map((path) => ({ path, matches: [] }));
  return all
    .flatMap((path) => rankOne(path, q) ?? [])
    .sort(
      (a, b) =>
        Number(b.inName) - Number(a.inName) ||
        a.runs - b.runs ||
        a.path.length - b.path.length ||
        alphabetical(a.path, b.path),
    )
    .slice(0, limit)
    .map(({ path, matches }) => ({ path, matches }));
}
