import { PathPattern } from '@10db/contracts';

/** A `(` after one of these starts an extglob such as `@(a|b)`. */
const EXTGLOB_MARKS: ReadonlySet<string> = new Set(['@', '!', '+', '*', '?']);
/** Characters the matcher reads as syntax that `looseGlob` turns into `?`. */
const SYNTAX: ReadonlySet<string> = new Set(['[', ']', '{', '}', '*', '?', '\\']);

const startsExtglob = (ch: string, glob: string) =>
  ch === '(' && EXTGLOB_MARKS.has(glob.at(-1) ?? '');

/**
 * Each character `matchesGlob` reads as syntax, as a class that matches only that character. Node's
 * matcher takes a backslash as a separator, never an escape, so a class is the only escape there is.
 * A backslash has none, and neither do braces where the path could make them expand (a comma or a
 * `..` beside them): those become `?`.
 */
function exactGlob(path: string): string {
  const expands = path.includes('{') && (path.includes(',') || path.includes('..'));
  let glob = '';
  for (const ch of path) {
    if (ch === '[' || ch === '*' || ch === '?') glob += `[${ch}]`;
    else if (startsExtglob(ch, glob)) glob += '[(]';
    else if (ch === '\\' || (expands && (ch === '{' || ch === '}'))) glob += '?';
    else glob += ch;
  }
  return glob;
}

/** Each character the matcher reads as syntax as `?`: a glob a project accepts, whatever the name. */
function looseGlob(path: string): string {
  let glob = '';
  for (const ch of path) {
    const driveColon = ch === ':' && /^[A-Za-z]$/u.test(glob);
    glob += SYNTAX.has(ch) || startsExtglob(ch, glob) || driveColon ? '?' : ch;
  }
  return glob;
}

/**
 * A glob for the repository path `path` that matches it and nothing else, and that a project accepts
 * as a path pattern. Where no such glob exists (a stray bracket, a backslash, braces that would
 * expand), the characters in the way become `?`, so it also matches a name that differs from `path`
 * only there.
 */
export function literalGlob(path: string): string {
  const exact = exactGlob(path);
  return path === '' || PathPattern.safeParse(exact).success ? exact : looseGlob(path);
}
