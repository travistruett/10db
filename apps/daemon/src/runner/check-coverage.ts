/** Flags that move a package manager or make into a folder before it runs. */
const DIR_FLAGS = ['--dir', '--prefix', '--cwd', '-C'];

/** What a step's check covers of a change, and what it left out. */
export interface CheckCoverage {
  readonly covers: readonly string[];
  readonly unchecked: readonly string[];
}

function normalized(dir: string): string {
  return dir.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
}

/** The folder one command segment runs in, or null when it names none (it runs from the root). */
function folderOf(tokens: readonly string[], inherited: string | null): string | null {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? '';
    for (const flag of DIR_FLAGS) {
      if (token === flag) return normalized(tokens[i + 1] ?? '');
      if (token.startsWith(`${flag}=`)) return normalized(token.slice(flag.length + 1));
    }
  }
  return inherited;
}

/**
 * The folders a check command covers, and the changed paths outside them. Null when the command
 * makes no claim to a folder: a segment that runs from the root (`make lint`, an unknown tool) covers
 * the whole repository, so nothing is left out. A `cd <dir> &&` or a `--dir`, `--prefix`, `--cwd` or
 * `-C` flag scopes a segment to that folder.
 */
export function checkCoverage(
  command: string,
  changedPaths: readonly string[],
): CheckCoverage | null {
  const folders = new Set<string>();
  let cwd: string | null = null;
  for (const segment of command.split(/&&|\|\||;|\n/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    if (tokens[0] === 'cd' && tokens[1] !== undefined) {
      cwd = normalized(tokens[1]);
      continue;
    }
    const folder = folderOf(tokens, cwd);
    if (folder === null || folder === '' || folder === '.' || folder.startsWith('..')) return null;
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
