import { posix } from 'node:path';

/** Reads a repository file as text, or null when it is absent; paths are relative to the repository root. */
export type ReadRepoFile = (path: string) => Promise<string | null>;

/** The names GNU make looks for when no `-f` is given, in the order it tries them. */
export const MAKEFILE_NAMES = ['GNUmakefile', 'makefile', 'Makefile'] as const;

export interface MakeRule {
  readonly prerequisites: readonly string[];
  readonly recipe: string;
}

/** The text without the lines that are only a comment (a recipe's too, whatever its prefix). */
export function withoutComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*[@+-]*\s*#/.test(line))
    .join('\n');
}

/** `rel` under `dir`, or null when it leaves the repository or is absolute; the root itself is `''`. */
export function within(dir: string, rel: string): string | null {
  if (rel.startsWith('/')) return null;
  const joined = posix.normalize(posix.join(dir, rel));
  if (joined === '..' || joined.startsWith('../')) return null;
  // `posix.join` leaves no `./` in front; only the folder itself is `.`. A dot name such as `.agents` stays.
  return joined === '.' ? '' : joined;
}

/** The rules of one Makefile by target name; a target named twice keeps both recipes. */
export function parseRules(text: string): Map<string, MakeRule[]> {
  const rules = new Map<string, MakeRule[]>();
  let current: { names: string[]; prerequisites: string[]; recipe: string[] } | null = null;
  const close = (): void => {
    if (current === null) return;
    const rule = { prerequisites: current.prerequisites, recipe: current.recipe.join('\n') };
    for (const name of current.names) rules.set(name, [...(rules.get(name) ?? []), rule]);
    current = null;
  };
  for (const line of text.split('\n')) {
    if (line.startsWith('\t')) {
      current?.recipe.push(line);
      continue;
    }
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    close();
    const head = /^([^\s:=#][^:=#]*):(?!=)([^=]*)$/.exec(line.replace(/#.*$/, ''));
    if (head === null) continue;
    current = {
      names: (head[1] ?? '').trim().split(/\s+/),
      // What follows `|` is order-only and needs no scan.
      prerequisites: (head[2] ?? '')
        .split('|', 1)
        .flatMap((normal) => normal.trim().split(/\s+/))
        .filter((name) => name !== ''),
      recipe: [],
    };
  }
  close();
  return rules;
}
