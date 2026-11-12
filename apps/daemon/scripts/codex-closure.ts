import { posix } from 'node:path';

export class ClosureError extends Error {
  override readonly name = 'ClosureError';
}

/** A relative module specifier in an `import … from` or `export … from` clause. */
const RELATIVE_FROM = /\bfrom\s+["'](\.\.?\/[^"']+)["']/g;

/**
 * Every file the seeds reach through relative imports, seeds included: POSIX paths relative to the
 * output root, each ending in `.ts`, sorted. `read` takes such a path and throws when there is no
 * file; an import naming one throws `ClosureError` naming both files.
 */
export function importClosure(read: (path: string) => string, seeds: readonly string[]): string[] {
  const seen = new Set<string>();
  const pending: { path: string; importer: string | null }[] = seeds.map((path) => ({
    path,
    importer: null,
  }));
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { path, importer } = next;
    if (seen.has(path)) continue;
    let text: string;
    try {
      text = read(path);
    } catch {
      throw new ClosureError(
        importer === null
          ? `seed ${path} cannot be read`
          : `${importer} imports ${path}, which cannot be read`,
      );
    }
    seen.add(path);
    for (const match of text.matchAll(RELATIVE_FROM)) {
      const specifier = match[1] ?? '';
      const target = posix.normalize(posix.join(posix.dirname(path), specifier));
      const file = target.endsWith('.ts') ? target : `${target}.ts`;
      if (file.startsWith('../'))
        throw new ClosureError(`${path} imports ${file}, outside the output root`);
      pending.push({ path: file, importer: path });
    }
  }
  return [...seen].sort();
}
