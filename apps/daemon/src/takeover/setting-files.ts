import { join } from 'node:path';
import { claudeProtectedPaths, isEqualOrUnder } from '../sandbox';

// The project files a terminal session doesn't load: Claude's settings, hooks and agent folders, and Codex's.

/**
 * The paths of `changed` (relative to `checkout`, as git lists them) that the terminal won't load: Claude's
 * protected files and folders and `.codex/`, compared the way the file system does (case and Unicode forms).
 */
export function settingFilesChanged(changed: readonly string[], checkout: string): string[] {
  const { files, directories } = claudeProtectedPaths(checkout);
  const folders = [...directories, join(checkout, '.codex')];
  return changed.filter((path) => {
    const full = join(checkout, path);
    return (
      files.some((file) => isEqualOrUnder(full, file) && isEqualOrUnder(file, full)) ||
      folders.some((folder) => isEqualOrUnder(full, folder))
    );
  });
}
