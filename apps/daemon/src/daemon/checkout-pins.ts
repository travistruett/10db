import { realpathSync } from 'node:fs';
import type { ProjectDto } from '@10db/contracts';
import {
  deleteAppSetting,
  getAppSetting,
  listProjects,
  setAppSetting,
  type DbReader,
} from '@10db/db';
import type { StateStore } from '../events';
import { CheckoutPin, type PinStore } from '../git';

function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** The project whose checkout is at `repo`, a real path; undefined when none is. */
export function projectAt(db: DbReader, repo: string): ProjectDto | undefined {
  return listProjects(db).find((project) => realOrNull(project.repoPath) === repo);
}

const key = (project: ProjectDto) => `checkout_pin.${project.id}`;

/**
 * Pins that persist in the database, one per project, so a restart keeps trusting only what the
 * builder trusted. A checkout no project uses keeps its pin in `fallback`.
 */
export function createProjectPinStore(state: StateStore, fallback: PinStore): PinStore {
  return {
    get(repo) {
      const project = projectAt(state.db, repo);
      if (!project) return fallback.get(repo);
      // The stored value is JSON read back from the database: a boundary, so parse it.
      const parsed = CheckoutPin.safeParse(getAppSetting(state.db, key(project)));
      return parsed.success ? parsed.data : undefined;
    },
    set(repo, pin) {
      const project = projectAt(state.db, repo);
      if (!project) {
        fallback.set(repo, pin);
        return;
      }
      state.write((ctx) => {
        setAppSetting(ctx, key(project), { ...pin });
      });
    },
    delete(repo) {
      const project = projectAt(state.db, repo);
      if (!project) {
        fallback.delete(repo);
        return;
      }
      state.write((ctx) => {
        deleteAppSetting(ctx, key(project));
      });
    },
  };
}
