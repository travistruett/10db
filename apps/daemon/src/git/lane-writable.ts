import { resolve } from 'node:path';
import { foldPathCase, realPathOf } from '../guard';

/** `path` with `..` collapsed as text, and as the kernel opens it; null when the second can't be read. */
function readings(path: string): string[] | null {
  try {
    return [resolve(path), realPathOf(path)];
  } catch {
    return null;
  }
}

function equalOrUnder(path: string, root: string): boolean {
  const p = foldPathCase(path);
  const r = foldPathCase(root);
  return p === r || p.startsWith(r.endsWith('/') ? r : `${r}/`);
}

/** True when two absolute paths name the same place, compared the way the file system compares them. */
export function samePath(a: string, b: string): boolean {
  return foldPathCase(resolve(a)) === foldPathCase(resolve(b));
}

/**
 * True when `path`, read either way, is one of `roots` or lies under one, also read either way, so
 * a link in the path or in a root can't hide it. A path that can't be resolved counts as inside.
 */
export function insideAny(path: string, roots: readonly string[]): boolean {
  const paths = readings(path);
  if (paths === null) return true;
  const rootPaths = roots.flatMap((root) => readings(root) ?? [resolve(root)]);
  return paths.some((p) => rootPaths.some((root) => equalOrUnder(p, root)));
}
