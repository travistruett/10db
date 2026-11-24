import { posix } from 'node:path';

/** Flags that move a package manager or make into a folder before it runs, whatever the tool. */
const DIR_FLAGS = ['--dir', '--prefix', '--cwd'];

/** Tools whose `-C` moves them into a folder (grep's and rg's `-C` is a count of context lines). */
const SHORT_DIR_TOOLS = new Set(['git', 'make', 'pnpm']);

/** What a step's check covers of a change, and what it left out. */
export interface CheckCoverage {
  readonly covers: readonly string[];
  readonly unchecked: readonly string[];
}

/** The word without its quotes; null when the shell would expand it into something unknown. */
function plainWord(word: string): string | null {
  const quoted = /^(["'])(.*)\1$/.exec(word);
  const text = quoted?.[2] ?? word;
  return /[$`*?[\]{}~]/.test(text) ? null : text;
}

/** `dir` taken from `cwd` (checkout-relative, '' for the root), or null when it leaves the checkout. */
function resolved(cwd: string, dir: string, root: string | null): string | null {
  let relative = dir;
  if (posix.isAbsolute(dir)) {
    if (root === null) return null;
    relative = posix.relative(root, dir);
  }
  const joined = posix.normalize(posix.join(cwd, relative));
  const clean = joined === '.' ? '' : joined.replace(/\/+$/, '');
  return clean === '..' || clean.startsWith('../') ? null : clean;
}

/** The folder one command segment runs in ('' for the root), or null when it can't be told. */
function folderOf(tokens: readonly string[], cwd: string, root: string | null): string | null {
  const shortFlag = SHORT_DIR_TOOLS.has(tokens[0] ?? '');
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? '';
    // git's `-C` moves it only before the subcommand; after it, `-C` is an option of the subcommand.
    const shortHere = shortFlag && (tokens[0] !== 'git' || i === 1);
    const flag = [...DIR_FLAGS, ...(shortHere ? ['-C'] : [])].find(
      (f) => token === f || token.startsWith(`${f}=`),
    );
    if (flag === undefined) continue;
    const value = plainWord(token === flag ? (tokens[i + 1] ?? '') : token.slice(flag.length + 1));
    return value === null || value === '' ? null : resolved(cwd, value, root);
  }
  return cwd;
}

/**
 * The folders a check command covers, and the changed paths outside them. Null when the command
 * makes no claim to a folder: a segment that runs from the root (`make lint`, an unknown tool) covers
 * the whole repository, so nothing is left out, and a folder the command names in a form that can't
 * be read (a variable, a glob, a place outside the checkout) is no claim either. A `cd <dir> &&`
 * moves the segments after it, and a `--dir`, `--prefix`, `--cwd` or (for git, make and pnpm) `-C`
 * flag moves its own segment, from wherever the cds left it. `root` is the checkout, which makes an
 * absolute folder checkout-relative.
 */
export function checkCoverage(
  command: string,
  changedPaths: readonly string[],
  root: string | null = null,
): CheckCoverage | null {
  const folders = new Set<string>();
  let cwd = '';
  for (const segment of command.split(/&&|\|\||;|\n/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    if (tokens[0] === 'cd') {
      const target = plainWord(tokens[1] ?? '');
      const next = target === null || target === '' ? null : resolved(cwd, target, root);
      if (next === null) return null;
      cwd = next;
      continue;
    }
    const folder = folderOf(tokens, cwd, root);
    if (folder === null || folder === '') return null;
    folders.add(folder);
  }
  if (folders.size === 0) return null;
  const covers = [...folders].sort();
  const unchecked = changedPaths.filter(
    (path) => !covers.some((folder) => path === folder || path.startsWith(`${folder}/`)),
  );
  return { covers, unchecked };
}

/** The evidence line for a check that passed with changes outside it; null when it left nothing out. */
export function coverageNote(coverage: CheckCoverage | null): string | null {
  if (coverage === null || coverage.unchecked.length === 0) return null;
  const [first = '', ...rest] = coverage.unchecked;
  const more = rest.length > 0 ? ` and ${String(rest.length)} more` : '';
  return `check covers ${coverage.covers.join(', ')}; ${first}${more} not checked`;
}
