import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Every entry under `root` that lies beside the ways down to each of `targets`, one level at a time:
 * what a deny of `root` covers, less every target and the folders that hold one. Claude Code's
 * permission rules take no exception and a deny wins over every allow, so this is how its rules can
 * keep a protected folder closed while folders inside it stay readable. The folders are read now: an
 * entry made later is not listed, and neither is anything under a folder that cannot be read.
 */
export function besideTheWays(root: string, targets: readonly string[]): string[] {
  const ways = targets.map((target) =>
    relative(root, target)
      .split(sep)
      .filter((part) => part !== ''),
  );
  // A target that is the root itself keeps all of it.
  if (ways.some((parts) => parts.length === 0)) return [];
  const beside: string[] = [];
  const walk = (dir: string, depth: number, under: readonly (readonly string[])[]): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const through = under.filter((parts) => parts[depth] === entry);
      if (through.length === 0) beside.push(join(dir, entry));
      // A target that ends here keeps everything in it.
      else if (through.every((parts) => parts.length > depth + 1))
        walk(join(dir, entry), depth + 1, through);
    }
  };
  walk(root, 0, ways);
  return beside;
}
