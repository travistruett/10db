/**
 * Whether two area globs can match the same file, judged from the globs alone, so a file added later
 * counts too. It reads globs as an area glob is matched (`areaMatches` in the daemon's guard): `*`,
 * `?` and a class take a dot name like any other character, `**` takes any number of folders but at
 * the end of a glob takes at least one name, and case is folded, as macOS folds it. What it cannot
 * read exactly it reads wider, so it may say two globs overlap when they do not, never the reverse:
 * an extglob (`@(a|b)`) is any one name, a POSIX class (`[[:alpha:]]`) any character, and a brace
 * range (`{1..9}`) `*`.
 */
export function globsOverlap(a: string, b: string): boolean {
  const left = expandBraces(a.toLowerCase()).map(segmentsOf);
  const right = expandBraces(b.toLowerCase()).map(segmentsOf);
  return left.some((x) => right.some((y) => segmentsOverlap(x, y)));
}

/** A range of code points, both ends included. */
type Span = readonly [number, number];

/** One character of a name: a literal, any character, or a class. */
type CharMatcher =
  | { readonly kind: 'char'; readonly code: number }
  | { readonly kind: 'any' }
  | { readonly kind: 'class'; readonly negated: boolean; readonly spans: readonly Span[] };

type Token = CharMatcher | { readonly kind: 'star' };

/** One folder or file name of a glob: `**`, any one name, or a pattern of tokens. */
type Segment =
  | { readonly kind: 'globstar' }
  | { readonly kind: 'name' }
  | { readonly kind: 'tokens'; readonly tokens: readonly Token[] };

const GLOBSTAR: Segment = { kind: 'globstar' };
const ANY_NAME: Segment = { kind: 'name' };
const STAR: Token = { kind: 'star' };
const ANY_CHAR: CharMatcher = { kind: 'any' };
const OPEN_BRACKET = 0x5b;

/** The index of the `}` that closes the `{` at `open`, or -1. */
function closingBrace(glob: string, open: number): number {
  let depth = 0;
  for (let i = open; i < glob.length; i += 1) {
    if (glob[i] === '{') depth += 1;
    else if (glob[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The parts of a brace body split at its top-level commas. */
function topLevelParts(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === '{') depth += 1;
    else if (body[i] === '}') depth -= 1;
    else if (body[i] === ',' && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

/** The globs a brace list stands for: `a{b,c}` is `ab` and `ac`. A range is read as `*`. */
function expandBraces(glob: string): string[] {
  const open = glob.indexOf('{');
  if (open === -1) return [glob];
  const close = closingBrace(glob, open);
  if (close === -1) return [glob];
  const head = glob.slice(0, open);
  const tail = glob.slice(close + 1);
  const parts = topLevelParts(glob.slice(open + 1, close));
  if (parts.length === 1) {
    const only = parts[0] ?? '';
    const middle = only.includes('..') ? '*' : `{${only}}`;
    // A brace with no comma is literal; only what follows it can still expand.
    return expandBraces(tail).map((rest) => `${head}${middle}${rest}`);
  }
  return parts.flatMap((part) => expandBraces(`${head}${part}${tail}`));
}

/** A `(` after one of these starts an extglob such as `@(a|b)`. */
const EXTGLOB_MARKS: ReadonlySet<string> = new Set(['?', '*', '+', '@', '!']);

/** The class that starts just after a `[` at `start`, and the index of its `]`; null when it never closes. */
function classAt(name: string, start: number): { matcher: CharMatcher; end: number } | null {
  let i = start;
  const negated = name[i] === '!' || name[i] === '^';
  if (negated) i += 1;
  const spans: Span[] = [];
  for (let first = true; i < name.length; i += 1, first = false) {
    const ch = name[i] ?? '';
    if (ch === ']' && !first) return { matcher: { kind: 'class', negated, spans }, end: i };
    if (ch === '[' && name[i + 1] === ':') {
      const end = name.indexOf(']]', i);
      return end === -1 ? null : { matcher: ANY_CHAR, end: end + 1 };
    }
    const low = ch.codePointAt(0) ?? 0;
    const high = name[i + 2];
    if (name[i + 1] === '-' && high !== undefined && high !== ']') {
      spans.push([low, high.codePointAt(0) ?? low]);
      i += 2;
    } else spans.push([low, low]);
  }
  return null;
}

function segmentOf(name: string): Segment {
  if (name === '**') return GLOBSTAR;
  const tokens: Token[] = [];
  for (let i = 0; i < name.length; i += 1) {
    const ch = name[i] ?? '';
    if (name[i + 1] === '(' && EXTGLOB_MARKS.has(ch)) return ANY_NAME;
    if (ch === '*') {
      if (tokens.at(-1) !== STAR) tokens.push(STAR);
    } else if (ch === '?') tokens.push(ANY_CHAR);
    else if (ch === '[') {
      const parsed = classAt(name, i + 1);
      if (parsed === null) tokens.push({ kind: 'char', code: OPEN_BRACKET });
      else {
        tokens.push(parsed.matcher);
        i = parsed.end;
      }
    } else tokens.push({ kind: 'char', code: ch.codePointAt(0) ?? 0 });
  }
  return { kind: 'tokens', tokens };
}

/**
 * A glob's names, with a `**` at the end written as one name followed by a `**` that may take none,
 * so every `**` left takes any number of names, none included.
 */
function segmentsOf(glob: string): Segment[] {
  const segments = glob
    .split('/')
    .filter((name) => name !== '' && name !== '.')
    .map(segmentOf);
  return segments.at(-1) === GLOBSTAR ? [...segments.slice(0, -1), ANY_NAME, GLOBSTAR] : segments;
}

/** Whether some code point lies in both lists of spans. */
const spansMeet = (a: readonly Span[], b: readonly Span[]) =>
  a.some(([lo, hi]) => b.some(([l, h]) => lo <= h && l <= hi));

/** Whether some code point in `spans` lies outside every span of `excluded`. */
function escapes(spans: readonly Span[], excluded: readonly Span[]): boolean {
  const sorted = [...excluded].sort((x, y) => x[0] - y[0]);
  return spans.some(([lo, hi]) => {
    let next = lo;
    for (const [l, h] of sorted) {
      if (l > next) break;
      if (h >= next) next = h + 1;
    }
    return next <= hi;
  });
}

/** A matcher as a set of code points: the spans listed, or every code point but them. */
function asSet(m: CharMatcher): { negated: boolean; spans: readonly Span[] } {
  switch (m.kind) {
    case 'char':
      return { negated: false, spans: [[m.code, m.code]] };
    case 'any':
      return { negated: true, spans: [] };
    case 'class':
      return { negated: m.negated, spans: m.spans };
  }
}

/** Whether one character can match both. */
function charsMeet(a: CharMatcher, b: CharMatcher): boolean {
  const x = asSet(a);
  const y = asSet(b);
  if (x.negated && y.negated) return true;
  if (x.negated) return escapes(y.spans, x.spans);
  if (y.negated) return escapes(x.spans, y.spans);
  return spansMeet(x.spans, y.spans);
}

/**
 * Whether one sequence can match both lists: `wild` items take any number of the other side's items,
 * none included; two other items must `meet`.
 */
function sequencesMeet<T>(
  a: readonly T[],
  b: readonly T[],
  wild: (item: T) => boolean,
  meet: (x: T, y: T) => boolean,
): boolean {
  const seen = new Map<number, boolean>();
  const from = (i: number, j: number): boolean => {
    const key = i * (b.length + 1) + j;
    const known = seen.get(key);
    if (known !== undefined) return known;
    const x = a[i];
    const y = b[j];
    let result: boolean;
    if (x === undefined && y === undefined) result = true;
    else if (x !== undefined && wild(x))
      result = from(i + 1, j) || (y !== undefined && from(i, j + 1));
    else if (y !== undefined && wild(y))
      result = from(i, j + 1) || (x !== undefined && from(i + 1, j));
    else result = x !== undefined && y !== undefined && meet(x, y) && from(i + 1, j + 1);
    seen.set(key, result);
    return result;
  };
  return from(0, 0);
}

const isStar = (token: Token) => token.kind === 'star';

/** Whether one name can match both. */
function namesMeet(a: Segment, b: Segment): boolean {
  if (a.kind !== 'tokens' || b.kind !== 'tokens') return true;
  return sequencesMeet<Token>(
    a.tokens,
    b.tokens,
    isStar,
    (x, y) =>
      // Neither is a star here: `wild` has taken those.
      x.kind !== 'star' && y.kind !== 'star' && charsMeet(x, y),
  );
}

/** Whether one path can match both lists of names. */
function segmentsOverlap(a: readonly Segment[], b: readonly Segment[]): boolean {
  return sequencesMeet(a, b, (s) => s.kind === 'globstar', namesMeet);
}
