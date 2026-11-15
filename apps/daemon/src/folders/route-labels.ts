import { posix } from 'node:path';
import { PageLabel } from '@10db/contracts';

// Workbench setup: the name a page goes by in the app, guessed from the nav that links to it, an
// object holding both a path (`to`, `path` or `href`) and a `label`.

const PATH_KEYS: ReadonlySet<string> = new Set(['to', 'path', 'href']);
const LABEL_KEY = 'label';
/** Base names that hold an app's nav: the label guesses are read from these besides the routers. */
const NAV_WORDS: readonly string[] = ['layout', 'nav', 'sidebar', 'menu', 'shell'];

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
 * The label each route is given by an object literal holding both a path (`to`, `path` or `href`,
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
      if (done?.path !== undefined && done.label !== undefined && !guesses.has(done.path))
        guesses.set(done.path, done.label);
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
      const value = text.slice(at + 1, stop - 1);
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

/** The label guesses of every text, the first text's winning for a route. */
export function routeLabelsOf(texts: Iterable<string>): Map<string, string> {
  const all = new Map<string, string>();
  for (const text of texts)
    for (const [route, label] of routeLabels(text)) if (!all.has(route)) all.set(route, label);
  return all;
}

/** Whether a file's name says it holds an app's nav: `app-layout.tsx`, `Sidebar.tsx`, `main-menu.ts`. */
export function isNavFile(path: string): boolean {
  const name = posix.basename(path).toLowerCase();
  return NAV_WORDS.some((word) => name.includes(word));
}
