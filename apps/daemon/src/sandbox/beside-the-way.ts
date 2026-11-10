import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Every entry under `root` that lies beside the way down to `target`, one level at a time: what a
 * deny of `root` covers, less `target` and the folders that hold it. Claude Code's permission rules
 * take no exception and a deny wins over every allow, so this is how its rules can keep a protected
 * folder closed while one folder inside it stays readable. The folders are read now: an entry made
 * later is not listed, and neither is anything under a folder that cannot be read.
 */
export function besideTheWay(root: string, target: string): string[] {
  const beside: string[] = [];
  let dir = root;
  for (const step of relative(root, target)
    .split(sep)
    .filter((part) => part !== '')) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      break;
    }
    for (const entry of entries) if (entry !== step) beside.push(join(dir, entry));
    dir = join(dir, step);
  }
  return beside;
}
