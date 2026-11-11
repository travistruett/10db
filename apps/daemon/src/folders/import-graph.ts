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

// Static imports and re-exports (`import x from`, `import {…} from`, `export * from`, `import '…'`),
// and `import('…')` or `require('…')` with a literal.
const STATIC_IMPORT =
  /(?:^|[^\w$.])(?:import|export)\s+(?:type\s+)?(?:[\w$*{}\s,]+?\s+from\s*)?(['"])([^'"\n]+)\1/gu;
const CALL_IMPORT = /(?:^|[^\w$.])(?:import|require)\s*\(\s*(['"])([^'"\n]+)\1\s*\)/gu;

/** The specifiers a source file imports, in the order they appear. */
export function importSpecifiers(text: string): string[] {
  const found: { at: number; specifier: string }[] = [];
  for (const pattern of [STATIC_IMPORT, CALL_IMPORT])
    for (const match of text.matchAll(pattern))
      if (match[2] !== undefined) found.push({ at: match.index, specifier: match[2] });
  return found.sort((a, b) => a.at - b.at).map((f) => f.specifier);
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
