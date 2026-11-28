import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { DecisionRule, type ProjectDto } from '@10db/contracts';
import { isRuleAsking } from '@10db/db';
import type { StateStore } from '../events';
import type { InboxService } from '../inbox';
import type { Logger } from '../log';
import { keptRoot, KeptCopyError, onlyHere, saveKept } from './kept-files';
import { post } from './context';
import { worktreeNotices } from './notices';

/** What saving a finished worktree's files needs: the database, the Inbox, the log and where files go. */
export interface SaveDeps {
  readonly state: StateStore;
  readonly inbox: InboxService;
  readonly logger: Logger;
  /** Where saved files go; the builder's kept folder when absent. */
  readonly keptRoot?: string | undefined;
}

/** What `saveLeftovers` found: ask the builder as before, or the worktree may go. */
export type Leftovers =
  /** The rule asks, or a copy failed: nothing was removed and today's card stands. */
  | { readonly kind: 'ask' }
  /** What only the worktree held is saved and verified (`dir` null when there was none). */
  | { readonly kind: 'saved'; readonly dir: string | null; readonly saved: readonly string[] };

/** A worktree's files that no longer exist have nothing to save; any other entry is a candidate. */
async function existing(worktree: string, files: readonly string[]): Promise<string[]> {
  const present: string[] = [];
  for (const file of files) {
    try {
      await lstat(join(worktree, file));
      present.push(file);
    } catch (error) {
      // Only a missing file is dropped: one that can't be read counts as present, so the copy
      // fails and the worktree stays.
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
        present.push(file);
    }
  }
  return present;
}

/**
 * Saves the files a finished worktree alone holds, for its removal. The candidates are `ignored` (its
 * git-ignored files 10db didn't seed) and `changed` (its uncommitted paths that still exist); those
 * with an identical file in the project's checkout, or that a tool writes again, are left out. What is
 * left goes under the kept folder as `name` and is verified before this answers `saved`. A rule set to
 * ask, or a copy that fails for any reason, answers `ask` having removed nothing.
 */
export async function saveLeftovers(
  deps: SaveDeps,
  project: ProjectDto,
  input: {
    readonly name: string;
    readonly path: string;
    readonly changed: readonly string[];
    readonly ignored: readonly string[];
    readonly at: Date;
  },
): Promise<Leftovers> {
  if (isRuleAsking(deps.state.db, project.id, DecisionRule.WorktreeLeftovers))
    return { kind: 'ask' };
  try {
    const candidates = [
      ...new Set([...input.ignored, ...(await existing(input.path, input.changed))]),
    ];
    const files = await onlyHere({
      worktree: input.path,
      checkout: project.repoPath,
      files: candidates,
    });
    if (files.length === 0) return { kind: 'saved', dir: null, saved: [] };
    const result = await saveKept({
      root: deps.keptRoot ?? keptRoot(),
      name: input.name,
      worktree: input.path,
      files,
      at: input.at,
    });
    return { kind: 'saved', dir: result.dir, saved: result.saved };
  } catch (error) {
    deps.logger.warn(
      {
        projectId: project.id,
        path: input.path,
        ...(error instanceof KeptCopyError ? { file: error.file } : {}),
        err: error instanceof Error ? error.message : String(error),
      },
      'finished worktree not saved, so kept',
    );
    return { kind: 'ask' };
  }
}

/** Posts the one notice that tells the builder what a removed worktree's saved files are and where. */
export function announceSaved(
  deps: SaveDeps,
  project: ProjectDto,
  path: string,
  saved: Extract<Leftovers, { kind: 'saved' }>,
): void {
  if (saved.dir === null) return;
  post(deps.inbox, project.id, worktreeNotices.savedAndRemoved(path, saved.dir, saved.saved));
}
