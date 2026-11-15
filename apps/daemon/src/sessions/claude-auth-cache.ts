import { lstat, unlink } from 'node:fs/promises';

/** The cache is something other than a file or a link, so it is left where it is. */
export class NeedsAuthCacheError extends Error {
  override readonly name = 'NeedsAuthCacheError';
}

/**
 * Deletes Claude Code's `mcp-needs-auth-cache.json` without reading it. A keyed session reads the builder's
 * sign-ins now, and a server marked needing sign-in by an earlier run would otherwise stay skipped for the
 * cache's lifetime. A missing file is fine; anything but a file or a link is refused.
 */
export async function removeStaleNeedsAuthCache(path: string): Promise<void> {
  let kind: { isFile(): boolean; isSymbolicLink(): boolean };
  try {
    kind = await lstat(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  if (!kind.isFile() && !kind.isSymbolicLink())
    throw new NeedsAuthCacheError('the needs-auth cache is not a file');
  try {
    await unlink(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
}
