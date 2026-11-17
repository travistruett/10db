import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ProjectDto } from '@10db/contracts';
import { takenBranchesAndPaths } from '@10db/db';
import { branchFor, type ChatMoveDeps } from '../chat';
import {
  cutChatWorktree,
  madeWorktreeRoot,
  worktreePathFor,
  type DeliveryContext,
} from '../delivery';
import type { StateStore } from '../events';

/**
 * What a session's move to a new branch needs of git and the worktree root: the names its title claims, and the
 * cut at the path its row names. A chat's worktree lives where a lane's does, in the project's folder under the
 * worktree root, with a `chat-` prefix that keeps it apart.
 */
export function createChatMove(deps: {
  readonly state: StateStore;
  readonly delivery: Pick<
    DeliveryContext,
    'state' | 'git' | 'logger' | 'dependencies' | 'worktreeRoot'
  >;
  readonly signal: AbortSignal;
}): ChatMoveDeps {
  const { state, delivery } = deps;
  return {
    signal: deps.signal,
    async pick(project: ProjectDto, title) {
      const root = madeWorktreeRoot(delivery.worktreeRoot);
      const pathOf = (branch: string): string => worktreePathFor(root, project, `chat-${branch}`);
      const recorded = takenBranchesAndPaths(state.db, project.id);
      const inGit = await delivery.git.localBranches(project.repoPath, '');
      const folder = dirname(pathOf('x'));
      const onDisk = existsSync(folder)
        ? readdirSync(folder).map((name) => join(folder, name))
        : [];
      return branchFor(
        title,
        {
          branches: [...inGit.map((b) => b.name), ...recorded.branches],
          paths: [...onDisk, ...recorded.paths],
        },
        pathOf,
      );
    },
    pathFor(project: ProjectDto, branch: string) {
      const root = madeWorktreeRoot(delivery.worktreeRoot);
      const recorded = takenBranchesAndPaths(state.db, project.id).paths.map((p) =>
        p.toLowerCase(),
      );
      for (let n = 1; ; n += 1) {
        const path = worktreePathFor(
          root,
          project,
          `chat-${n === 1 ? branch : `${branch}-${String(n)}`}`,
        );
        if (!existsSync(path) && !recorded.includes(path.toLowerCase()))
          return Promise.resolve(path);
      }
    },
    cut: (chat, project, signal) => cutChatWorktree(delivery, chat, project, signal),
  };
}
