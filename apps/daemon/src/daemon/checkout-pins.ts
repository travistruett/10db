import { realpathSync } from 'node:fs';
import type { ProjectDto } from '@10db/contracts';
import {
  deleteAppSetting,
  findBatchByWorktreePath,
  getAppSetting,
  getProject,
  listProjects,
  setAppSetting,
  type DbReader,
} from '@10db/db';
import { worktreePinKey } from '../delivery';
import type { StateStore } from '../events';
import { CheckoutPin, type PinStore } from '../git';

function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** The project whose checkout is at `repo`, a real path, or whose batch has a worktree there. */
export function projectAt(db: DbReader, repo: string): ProjectDto | undefined {
  return pinOwner(db, repo)?.project;
}

export { worktreePinKey };

const projectPinKey = (project: ProjectDto): string => `checkout_pin.${project.id}`;

/** Who a pin at `repo` belongs to, and the setting that holds it. */
function pinOwner(
  db: DbReader,
  repo: string,
): { readonly project: ProjectDto; readonly key: string } | undefined {
  const project = listProjects(db).find((candidate) => realOrNull(candidate.repoPath) === repo);
  if (project) return { project, key: projectPinKey(project) };
  const batch = findBatchByWorktreePath(db, repo);
  if (!batch) return undefined;
  return { project: getProject(db, batch.projectId), key: worktreePinKey(batch.id) };
}

/**
 * Pins that persist in the database, one per project checkout and one per batch worktree, so a
 * restart keeps trusting only what the builder trusted. A checkout no project or batch uses keeps
 * its pin in `fallback`.
 */
export function createProjectPinStore(state: StateStore, fallback: PinStore): PinStore {
  return {
    get(repo) {
      const owner = pinOwner(state.db, repo);
      if (!owner) return fallback.get(repo);
      // The stored value is JSON read back from the database: a boundary, so parse it.
      const parsed = CheckoutPin.safeParse(getAppSetting(state.db, owner.key));
      return parsed.success ? parsed.data : undefined;
    },
    set(repo, pin) {
      const owner = pinOwner(state.db, repo);
      if (!owner) {
        fallback.set(repo, pin);
        return;
      }
      state.write((ctx) => {
        setAppSetting(ctx, owner.key, { ...pin });
      });
    },
    delete(repo) {
      const owner = pinOwner(state.db, repo);
      if (!owner) {
        fallback.delete(repo);
        return;
      }
      state.write((ctx) => {
        deleteAppSetting(ctx, owner.key);
      });
    },
  };
}
