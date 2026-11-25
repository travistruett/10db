import {
  NotFoundError,
  type EvalManifest,
  type EvalManifestResult,
  type EvalsDto,
  type EvalSuiteDetailDto,
  type HazardDef,
  type ProjectId,
} from '@10db/contracts';
import type { StateStore } from '../events';
import type { Git } from '../git';
import { classifyPath } from '../guard';
import type { Logger } from '../log';
import { buildEvals, buildSuiteDetail } from './build';
import { readEvalManifest, writeEvalManifest } from './manifest-store';
import { createEvalsCache, readEvals, type FoundEvals } from './read-results';

export interface EvalsService {
  read(projectId: ProjectId, repoPath: string): Promise<EvalsDto>;
  suite(
    projectId: ProjectId,
    repoPath: string,
    key: string,
    run: string | undefined,
  ): Promise<EvalSuiteDetailDto>;
  record(
    projectId: ProjectId,
    repoPath: string,
    manifest: EvalManifest,
  ): Promise<EvalManifestResult>;
}

export interface EvalsDeps {
  readonly state: StateStore;
  readonly git: Pick<Git, 'survey' | 'surveyTexts' | 'commitAt'>;
  readonly logger: Logger;
}

/** The tracked files `glob` holds, as a hazard's glob holds them. */
function globHolds(glob: string, tracked: ReadonlySet<string>): boolean {
  const probe: HazardDef = { name: 'probe', globs: [glob], commands: [] };
  for (const path of tracked) {
    if (classifyPath(path, [], [probe]).hazards.length > 0) return true;
  }
  return false;
}

/** What a manifest names that HEAD does not track: a definition path, or a glob that holds no file. */
function untrackedIn(manifest: EvalManifest, found: FoundEvals): string[] {
  const out: string[] = [];
  for (const suite of manifest.suites) {
    for (const path of suite.definitionPaths) if (!found.tracked.has(path)) out.push(path);
    for (const glob of suite.coveredPaths) if (!globHolds(glob, found.tracked)) out.push(glob);
  }
  return [...new Set(out)];
}

/**
 * A project's committed eval results at HEAD, read through git's object store and never run, with the
 * manifest an agent recorded laid over them. The parsed results are kept per checkout while HEAD stays put.
 */
export function createEvalsService(deps: EvalsDeps): EvalsService {
  const cache = createEvalsCache();
  const found = (repoPath: string): Promise<FoundEvals | null> =>
    readEvals(deps.git, repoPath, deps.logger, cache);
  return {
    async read(projectId, repoPath) {
      return buildEvals(await found(repoPath), readEvalManifest(deps.state.db, projectId));
    },
    async suite(projectId, repoPath, key, run) {
      const result = buildSuiteDetail(
        await found(repoPath),
        readEvalManifest(deps.state.db, projectId),
        key,
        run,
      );
      if (result.kind === 'no_suite') throw new NotFoundError('Eval suite', key);
      if (result.kind === 'no_run') throw new NotFoundError('Eval run', run ?? '');
      return result.detail;
    },
    async record(projectId, repoPath, manifest) {
      const read = await found(repoPath);
      if (read === null) {
        return { ok: false, untracked: [], message: 'The repository has no commit to read.' };
      }
      const untracked = untrackedIn(manifest, read);
      if (untracked.length > 0) {
        return {
          ok: false,
          untracked,
          message: `Not tracked at HEAD, so nothing was recorded: ${untracked.join(', ')}`,
        };
      }
      const stored = { manifest, commit: read.commit, assessedAt: deps.state.now() };
      deps.state.write((ctx) => {
        writeEvalManifest(ctx, projectId, stored);
      });
      return { ok: true, evals: buildEvals(read, stored) };
    },
  };
}
