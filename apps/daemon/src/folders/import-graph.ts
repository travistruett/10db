import { posix } from 'node:path';
import { z } from 'zod';

/** The files an import graph is built over. */
export const SOURCE_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

export const isSourceFile = (path: string): boolean =>
  SOURCE_EXTENSIONS.includes(posix.extname(path));

/** One `compilerOptions.paths` entry: `@/*` is prefix `@/`, suffix `''`, with a wildcard. */
interface PathAlias {
  readonly prefix: string;
  readonly suffix: string;
  readonly wildcard: boolean;
  /** Repository paths, with `*` where the wildcard's match goes. */
  readonly targets: readonly string[];
}

/** What a unit's tsconfig says about where a non-relative specifier points. */
export interface PathAliases {
  /** `compilerOptions.baseUrl` as a repository path, or null. */
  readonly base: string | null;
  readonly paths: readonly PathAlias[];
}

export const NO_ALIASES: PathAliases = { base: null, paths: [] };

/** The part of a tsconfig or jsconfig the import graph reads; the rest is ignored. */
const ConfigFile = z.object({
  compilerOptions: z
    .object({
      baseUrl: z.string().optional(),
      paths: z.record(z.string(), z.array(z.string())).optional(),
    })
    .optional(),
});

/** `text` with its `//` and `/* *\/` comments gone, strings kept whole. */
function withoutComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i] ?? '';
    if (ch === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
    } else if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close === -1 ? text.length : close + 2;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** The index just past the JSON string that opens at `start`. */
function stringEnd(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
  return i + 1;
}

/** `text` with each comma that closes an object or array gone, strings kept whole. */
function withoutTrailingCommas(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i] ?? '';
    if (ch === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === ',') {
      let next = i + 1;
      while (next < text.length && /\s/u.test(text[next] ?? '')) next += 1;
      if (text[next] === '}' || text[next] === ']') {
        i += 1;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** A path relative to `dir`, as a repository path; null when it leaves the repository. */
function within(dir: string, path: string): string | null {
  const joined = posix.normalize(posix.join(dir === '' ? '.' : dir, path));
  if (joined === '..' || joined.startsWith('../') || posix.isAbsolute(joined)) return null;
  return joined === '.' ? '' : joined.replace(/\/$/u, '');
}

/**
 * The aliases of the tsconfig or jsconfig at `config.path`, read as TypeScript reads one (comments
 * and trailing commas allowed). One that does not parse, or is not of tsconfig's shape, has none.
 * `extends` is not followed.
 */
export function readPathAliases(config: { path: string; text: string } | null): PathAliases {
  if (config === null) return NO_ALIASES;
  let raw: unknown;
  try {
    raw = JSON.parse(withoutTrailingCommas(withoutComments(config.text)));
  } catch {
    return NO_ALIASES;
  }
  const parsed = ConfigFile.safeParse(raw);
  if (!parsed.success) return NO_ALIASES;
  const options = parsed.data.compilerOptions ?? {};
  const dir = posix.dirname(config.path) === '.' ? '' : posix.dirname(config.path);
  const base = options.baseUrl === undefined ? null : within(dir, options.baseUrl);
  // TypeScript reads `paths` from the baseUrl when there is one, else from the config's folder.
  const from = base ?? dir;
  const paths = Object.entries(options.paths ?? {}).flatMap(([pattern, targets]): PathAlias[] => {
    const star = pattern.indexOf('*');
    const resolved = targets.flatMap((t) => {
      const path = within(from, t);
      return path === null ? [] : [path];
    });
    if (star === -1) return [{ prefix: pattern, suffix: '', wildcard: false, targets: resolved }];
    return [
      {
        prefix: pattern.slice(0, star),
        suffix: pattern.slice(star + 1),
        wildcard: true,
        targets: resolved,
      },
    ];
  });
  return { base, paths };
}

/** What one import statement, re-export, `import('…')` or `require('…')` names. */
export interface ImportBinding {
  readonly specifier: string;
  /** The local names it binds (`import A, { b as c }` binds `A` and `c`). */
  readonly locals: readonly string[];
}

/** Letters, `_` and `$` start an identifier; digits continue one. Code points, not a regex, per character. */
function isIdStart(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  const c = ch.charCodeAt(0);
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 36;
}
function isIdPart(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  const c = ch.charCodeAt(0);
  return isIdStart(ch) || (c >= 48 && c <= 57);
}
const isSpace = (ch: string | undefined): boolean =>
  ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '\v';
const isQuote = (ch: string | undefined): boolean => ch === "'" || ch === '"' || ch === '`';

/**
 * A linear scanner over a source file's text for what it imports. Strings, template literals and
 * comments are stepped over whole; each character is read a bounded number of times, so no text a
 * repository holds can make it slow.
 */
class ImportScanner {
  readonly text: string;
  at = 0;
  constructor(text: string) {
    this.text = text;
  }

  /** Steps past whitespace and comments. */
  skipSpace(): void {
    const { text } = this;
    for (;;) {
      if (isSpace(text[this.at])) this.at += 1;
      else if (text[this.at] === '/' && text[this.at + 1] === '/') {
        const end = text.indexOf('\n', this.at);
        this.at = end === -1 ? text.length : end;
      } else if (text[this.at] === '/' && text[this.at + 1] === '*') {
        const end = text.indexOf('*/', this.at + 2);
        this.at = end === -1 ? text.length : end + 2;
      } else return;
    }
  }

  /** Steps past the string or template literal that opens here. */
  skipString(): void {
    const quote = this.text[this.at];
    this.at += 1;
    while (this.at < this.text.length && this.text[this.at] !== quote)
      this.at += this.text[this.at] === '\\' ? 2 : 1;
    this.at += 1;
  }

  /** The one-line `'…'` or `"…"` literal that opens here, read past; null (reading nothing) otherwise. */
  readSpecifier(): string | null {
    const quote = this.text[this.at];
    if (quote !== "'" && quote !== '"') return null;
    let end = this.at + 1;
    while (end < this.text.length && this.text[end] !== quote && this.text[end] !== '\n') end += 1;
    if (this.text[end] !== quote || end === this.at + 1) return null;
    const value = this.text.slice(this.at + 1, end);
    this.at = end + 1;
    return value;
  }

  readWord(): string {
    const start = this.at;
    while (isIdPart(this.text[this.at])) this.at += 1;
    return this.text.slice(start, this.at);
  }

  /** `( '…' )` after `import` or `require`. */
  call(): ImportBinding | null {
    this.at += 1;
    this.skipSpace();
    const specifier = this.readSpecifier();
    if (specifier === null) return null;
    this.skipSpace();
    if (this.text[this.at] !== ')') return null;
    this.at += 1;
    return { specifier, locals: [] };
  }

  /** The clause of `import …` or `export …` up to `from '…'`; null at anything else. */
  clause(): ImportBinding | null {
    const locals: string[] = [];
    let braces = false;
    let renaming = false;
    let words = 0;
    for (;;) {
      this.skipSpace();
      const ch = this.text[this.at];
      if (ch === '{' || ch === '}' || ch === ',' || ch === '*') {
        braces = ch === '{' ? true : ch === '}' ? false : braces;
        this.at += 1;
        continue;
      }
      if (!isIdStart(ch)) return null;
      const word = this.readWord();
      words += 1;
      if (word === 'from' && !braces && !renaming) {
        this.skipSpace();
        const specifier = this.readSpecifier();
        return specifier === null ? null : { specifier, locals };
      }
      if (word === 'as') renaming = true;
      else if (word === 'type' && (words === 1 || braces)) continue;
      else if (renaming) {
        locals.pop();
        locals.push(word);
        renaming = false;
      } else locals.push(word);
    }
  }

  /** What the `import`, `export` or `require` just read starts, if it imports. */
  statement(keyword: string): ImportBinding | null {
    this.skipSpace();
    const ch = this.text[this.at];
    if (keyword === 'require') return ch === '(' ? this.call() : null;
    if (keyword === 'import') {
      if (ch === '(') return this.call();
      if (ch === "'" || ch === '"') {
        const specifier = this.readSpecifier();
        return specifier === null ? null : { specifier, locals: [] };
      }
    }
    return this.clause();
  }

  scan(): ImportBinding[] {
    const found: ImportBinding[] = [];
    const { text } = this;
    let member = false;
    while (this.at < text.length) {
      const ch = text[this.at];
      if (isQuote(ch)) {
        this.skipString();
        member = false;
      } else if (ch === '/' && (text[this.at + 1] === '/' || text[this.at + 1] === '*')) {
        this.skipSpace();
      } else if (isIdStart(ch)) {
        const word = this.readWord();
        if (!member && (word === 'import' || word === 'export' || word === 'require')) {
          const binding = this.statement(word);
          if (binding !== null) found.push(binding);
        }
        member = false;
      } else {
        if (!isSpace(ch)) member = ch === '.';
        this.at += 1;
      }
    }
    return found;
  }
}

/** Each import, re-export, `import('…')` and `require('…')` with a literal, in the order they appear. */
export function importBindings(text: string): ImportBinding[] {
  return new ImportScanner(text).scan();
}

/** The specifiers a source file imports, in the order they appear. */
export function importSpecifiers(text: string): string[] {
  return importBindings(text).map((b) => b.specifier);
}

const ESM_NAMES: Readonly<Record<string, readonly string[]>> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

/** The tracked source file a repository path names: itself, with an extension, or its folder's index. */
function fileAt(path: string, tracked: ReadonlySet<string>): string | null {
  const ext = posix.extname(path);
  if (isSourceFile(path) && tracked.has(path)) return path;
  for (const other of ESM_NAMES[ext] ?? []) {
    const swapped = `${path.slice(0, -ext.length)}${other}`;
    if (tracked.has(swapped)) return swapped;
  }
  for (const candidate of SOURCE_EXTENSIONS)
    if (tracked.has(`${path}${candidate}`)) return `${path}${candidate}`;
  for (const candidate of SOURCE_EXTENSIONS)
    if (tracked.has(`${path}/index${candidate}`)) return `${path}/index${candidate}`;
  return null;
}

/** The paths an aliased specifier could name, best first. */
function aliasTargets(specifier: string, aliases: PathAliases): string[] {
  const targets: string[] = [];
  for (const alias of aliases.paths) {
    if (!alias.wildcard) {
      if (specifier === alias.prefix) targets.push(...alias.targets);
      continue;
    }
    if (
      specifier.length < alias.prefix.length + alias.suffix.length ||
      !specifier.startsWith(alias.prefix) ||
      !specifier.endsWith(alias.suffix)
    )
      continue;
    const match = specifier.slice(alias.prefix.length, specifier.length - alias.suffix.length);
    targets.push(...alias.targets.map((t) => t.replace('*', match)));
  }
  if (aliases.base !== null) {
    const based = within(aliases.base, specifier);
    if (based !== null) targets.push(based);
  }
  return targets;
}

/**
 * The tracked source file `specifier`, imported by `from`, names: a relative path, or one the
 * aliases map, with an extension or `/index.*` found. A package name, or a path to no tracked source
 * file, is null.
 */
export function resolveImport(
  from: string,
  specifier: string,
  aliases: PathAliases,
  tracked: ReadonlySet<string>,
): string | null {
  if (specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.') {
    const path = within(posix.dirname(from), specifier);
    return path === null ? null : fileAt(path, tracked);
  }
  for (const target of aliasTargets(specifier, aliases)) {
    const file = fileAt(target, tracked);
    if (file !== null) return file;
  }
  return null;
}
