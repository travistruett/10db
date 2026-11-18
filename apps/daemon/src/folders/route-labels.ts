import { posix } from 'node:path';
import { PageLabel } from '@10db/contracts';

// Workbench setup: the name a page goes by in the app, guessed from the nav that links to it, an
// object holding both a path (`to`, `path`, `href` or `route`) and a `label`.

const PATH_KEYS: ReadonlySet<string> = new Set(['to', 'path', 'href', 'route']);
const LABEL_KEY = 'label';

/** A string literal's text with an escaped quote or backslash read as the character it stands for. */
function unescaped(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const next = raw[i + 1];
    if (raw[i] === '\\' && (next === "'" || next === '"' || next === '\\')) {
      out += next;
      i += 1;
    } else out += raw.charAt(i);
  }
  return out;
}

/** A route without a trailing slash, the root kept: `/board/` is `/board`. */
export function routeKey(route: string): string {
  let end = route.length;
  while (end > 1 && route[end - 1] === '/') end -= 1;
  return route.slice(0, end);
}

const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[\w$]/u.test(ch);

/** The index just past the `'` or `"` string opening at `start`; a string ends at a line's end too. */
function quotedEnd(text: string, start: number): number {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length && text[i] !== quote) {
    if (text[i] === '\n') return i;
    i += text[i] === '\\' ? 2 : 1;
  }
  return Math.min(i + 1, text.length);
}

/** The index just past a template literal opening at `start`, its `${}` parts stepped over by depth. */
function templateEnd(text: string, start: number): number {
  let i = start + 1;
  let depth = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') i += 2;
    else if (depth === 0 && ch === '`') return i + 1;
    else if (ch === '$' && text[i + 1] === '{') {
      depth += 1;
      i += 2;
    } else if (depth > 0 && ch === '}') {
      depth -= 1;
      i += 1;
    } else i += 1;
  }
  return text.length;
}

/** What one object literal says so far: its path and its label, when its keys held string literals. */
interface Entry {
  path?: string;
  label?: string;
}

/**
 * The label each route is given by an object literal holding both a path (`to`, `path`, `href` or `route`,
 * starting with `/`) and a `label`, in one linear pass: strings and comments are stepped over, each
 * object's keys are read as they come and an object that closes holding both says one guess. The
 * first label a route gets stands. A label that is not one line of 1-40 characters is no guess.
 */
export function routeLabels(text: string): Map<string, string> {
  const guesses = new Map<string, string>();
  const objects: Entry[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      i = quotedEnd(text, i);
    } else if (ch === '`') {
      i = templateEnd(text, i);
    } else if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else if (ch === '{') {
      objects.push({});
      i += 1;
    } else if (ch === '}') {
      const done = objects.pop();
      const key = done?.path === undefined ? undefined : routeKey(done.path);
      if (key !== undefined && done?.label !== undefined && !guesses.has(key))
        guesses.set(key, done.label);
      i += 1;
    } else if (isWordChar(ch) && !isWordChar(text[i - 1])) {
      let end = i + 1;
      while (isWordChar(text[end])) end += 1;
      const word = text.slice(i, end);
      i = end;
      const entry = objects.at(-1);
      let at = i;
      while (text[at] === ' ' || text[at] === '\t') at += 1;
      if (entry === undefined || text[at] !== ':') continue;
      at += 1;
      while (text[at] === ' ' || text[at] === '\t') at += 1;
      const quote = text[at];
      if (quote !== "'" && quote !== '"') continue;
      const stop = quotedEnd(text, at);
      if (text[stop - 1] !== quote || stop - 1 === at) continue;
      const value = unescaped(text.slice(at + 1, stop - 1));
      i = stop;
      if (PATH_KEYS.has(word) && value.startsWith('/') && entry.path === undefined)
        entry.path = value;
      else if (word === LABEL_KEY && entry.label === undefined) {
        const label = PageLabel.safeParse(value.trim());
        if (label.success) entry.label = label.data;
      }
    } else i += 1;
  }
  return guesses;
}

/**
 * The label guesses of every file's text. Where two labels claim a route, a file named like a nav
 * (`isNavFile`) beats another file, and the first read beats a later one.
 */
export function routeLabelsOf(
  files: Iterable<readonly [file: string, text: string]>,
): Map<string, string> {
  const all = [...files];
  const out = new Map<string, string>();
  for (const wantNav of [true, false])
    for (const [file, text] of all) {
      if (isNavFile(file) !== wantNav) continue;
      for (const [route, label] of routeLabels(text)) if (!out.has(route)) out.set(route, label);
    }
  return out;
}

/** Names a nav file is called by, whole words of its base name. */
const NAV_WORDS: ReadonlySet<string> = new Set([
  'layout',
  'nav',
  'navbar',
  'navigation',
  'rail',
  'sidebar',
  'menu',
  'shell',
]);

/** Where a file is a test, a story or an end-to-end script, whose fixtures are no nav. */
const NOT_NAV = /(?:\.(?:test|spec|stories)\.)|(?:^|\/)(?:__tests__|e2e)\//u;

/**
 * Whether a file's name says it holds an app's nav: a whole word of its base name (split on `-`, `_`,
 * `.` and case) is layout, nav, navbar, navigation, rail, sidebar, menu or shell. `navigate.ts`, tests,
 * stories and `e2e/` files are not.
 */
export function isNavFile(path: string): boolean {
  if (NOT_NAV.test(path)) return false;
  const stem = posix.basename(path, posix.extname(path));
  const words = stem
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .split(/[\s\-_.]+/u)
    .map((word) => word.toLowerCase());
  return words.some((word) => NAV_WORDS.has(word));
}
