import { posix } from 'node:path';
import { ToolCallKind, ToolCallStatus, type ToolCallView } from '@10db/contracts';

// The files a session changed, for the title row's Commit to offer as its default list: the edits its calls made
// and that were allowed to run. A denied, failed or unfinished edit changed nothing, and a path outside the
// session's root is somebody else's file.

/** `path` relative to `root`, or null when it lies outside it. */
function insideRoot(path: string, root: string): string | null {
  const relative = posix.relative(root, posix.resolve(root, path));
  if (relative === '' || relative === '..' || relative.startsWith('../')) return null;
  return relative;
}

/** The root-relative paths of the allowed edits among `items`, sorted and unique. */
export function touchedPaths(items: readonly ToolCallView[], root: string): string[] {
  const found = new Set<string>();
  for (const item of items) {
    if (item.kind !== ToolCallKind.Edit || item.status !== ToolCallStatus.Done) continue;
    for (const path of [item.path, item.movePath]) {
      if (path === null) continue;
      const relative = insideRoot(path, root);
      if (relative !== null) found.add(relative);
    }
  }
  return [...found].sort();
}
