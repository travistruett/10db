import { lstat, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import {
  NotFoundError,
  EvalManifestSource,
  type EvalManifest,
  type EvalCoverageSideDto,
  type EvalCoverageState,
  type EvalManifestResult,
  type EvalLiveModels,
  type EvalModelsDto,
  type EvalsDto,
  type EvalSwitchBody,
  type NewEvalBody,
  type EvalSuiteDetailDto,
  type HazardDef,
  type ProjectId,
  type StoredEvalManifest,
} from '@10db/contracts';
import type { StateStore } from '../events';
import type { Git } from '../git';
import { classifyPath } from '../guard';
import type { Logger } from '../log';
import { buildEvals, buildSuiteDetail, type DefinitionTimes, type Discovery } from './build';
import {
  findCallSites,
  patternsOf,
  uncoveredSites,
  type CallSite,
  type FoundCallSites,
} from './call-sites';
import { coverageOf, sideOf } from './coverage';
import { evalDrift } from './drift';
import { evalTaskDraft, findEvalSkills, type EvalTaskDraft } from './new-eval-task';
import { switchTaskDraft } from './switch-task';
import { readEvalManifest, writeEvalManifest } from './manifest-store';
import { buildModels } from './models';
import { createEvalsCache, readEvals, type FoundEvals } from './read-results';
import type { ParsedRun } from './run-summary';

/** A suite and the times a task's branch point and last commit were committed. */
export interface CoverageQuery {
  readonly key: string;
  readonly baseAt: string | null;
  readonly headAt: string | null;
}

/** A covered suite's results on either side of a task, as the checkout holds them now. */
export interface CoverageStanding {
  readonly state: EvalCoverageState;
  readonly before: EvalCoverageSideDto | null;
  readonly after: EvalCoverageSideDto | null;
}

export interface EvalsService {
  read(projectId: ProjectId, repoPath: string): Promise<EvalsDto>;
  suite(
    projectId: ProjectId,
    repoPath: string,
    key: string,
    run: string | undefined,
  ): Promise<EvalSuiteDetailDto>;
  /** Every model the project's results graded, with its newest result per suite. */
  models(projectId: ProjectId, repoPath: string): Promise<EvalModelsDto>;
  /** What a suite's candidates are built from: where it takes its models from and its runs, oldest first. */
  candidateBasis(
    projectId: ProjectId,
    repoPath: string,
    key: string,
  ): Promise<{ models: EvalLiveModels | null; runs: readonly ParsedRun[] }>;
  record(
    projectId: ProjectId,
    repoPath: string,
    manifest: EvalManifest,
    source?: EvalManifestSource,
  ): Promise<EvalManifestResult>;
  /** Where each queried suite stands against its task's times, in the checkout's results as read now. */
  standing(repoPath: string, queries: readonly CoverageQuery[]): Promise<CoverageStanding[]>;
  /** The task that drafts an eval for `request`: the project's eval skill and suites read at HEAD, never run. */
  draftTask(projectId: ProjectId, repoPath: string, request: NewEvalBody): Promise<EvalTaskDraft>;
  /** The task that switches a suite's model binding, with the suite's covered paths for its areas. */
  draftSwitch(
    projectId: ProjectId,
    repoPath: string,
    key: string,
    request: EvalSwitchBody,
  ): Promise<EvalTaskDraft & { readonly coveredPaths: readonly string[] }>;
}

export interface EvalsDeps {
  readonly state: StateStore;
  readonly git: Pick<
    Git,
    'survey' | 'commitAt' | 'lastChangedAt' | 'grepAt' | 'filesAt' | 'surveyTexts'
  >;
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

/** A tracked path as a glob that matches only itself: git's glob pathspec reads `*`, `?`, `[` and `\\`. */
const literalGlob = (path: string): string => path.replace(/[*?[\]\\]/gu, (c) => `\\${c}`);

/** The most untracked names reported before the check stops. */
const MAX_REPORTED = 20;

/** What a manifest names that HEAD does not track: a definition path, or a glob that holds no file. */
function untrackedIn(manifest: EvalManifest, found: FoundEvals): string[] {
  const out = new Set<string>();
  const checked = new Set<string>();
  for (const suite of manifest.suites) {
    for (const path of suite.definitionPaths) {
      if (!found.tracked.has(path)) out.add(path);
      if (out.size >= MAX_REPORTED) return [...out];
    }
    for (const glob of suite.coveredPaths) {
      if (checked.has(glob)) continue;
      checked.add(glob);
      if (!globHolds(glob, found.tracked)) out.add(glob);
      if (out.size >= MAX_REPORTED) return [...out];
    }
  }
  return [...out];
}

/**
 * The env files a manifest's live settings name that are not a regular file in the working tree. They are
 * untracked, so HEAD can't vouch for them; a link, or a name that resolves outside the checkout, is refused so
 * the sandbox's read grant can't be led out of it.
 */
async function missingEnvFiles(manifest: EvalManifest, repoPath: string): Promise<string[]> {
  const out = new Set<string>();
  const root = await realpath(repoPath).catch(() => '');
  for (const suite of manifest.suites) {
    for (const file of suite.live?.envFiles ?? []) {
      if (out.has(file)) continue;
      const path = join(repoPath, file);
      const stat = await lstat(path).catch(() => null);
      // A linked directory in the name can lead outside the checkout, so the resolved path must stay inside it.
      const real = stat?.isFile() ? await realpath(path).catch(() => '') : '';
      if (root === '' || !real.startsWith(root + sep)) out.add(file);
    }
  }
  return [...out];
}

/** Reads of a commit kept by key, the newest few: a commit's files and call sites never change. */
const KEPT_COMMIT_READS = 16;

function keptByCommit<T>(): (key: string, read: () => Promise<T>) => Promise<T> {
  const held = new Map<string, Promise<T>>();
  return (key, read) => {
    const kept = held.get(key);
    if (kept !== undefined) {
      held.delete(key);
      held.set(key, kept);
      return kept;
    }
    const next = read();
    held.set(key, next);
    // A failed read is not kept, so the next open asks again.
    next.catch(() => held.delete(key));
    for (const old of held.keys()) {
      if (held.size <= KEPT_COMMIT_READS) break;
      held.delete(old);
    }
    return next;
  };
}

/**
 * A project's eval files at HEAD and its result files from the checkout, never run, with the
 * manifest an agent recorded laid over them. The parsed results are kept per checkout while HEAD stays put.
 */
export function createEvalsService(deps: EvalsDeps): EvalsService {
  const cache = createEvalsCache();
  const found = (repoPath: string): Promise<FoundEvals | null> =>
    readEvals(deps.git, repoPath, deps.logger, cache);
  // A definition's last commit is a fact of HEAD, so it is read once per commit and path list, and only the
  // checkout's current HEAD is kept. A failed read is not kept, so the next open asks again.
  const committed = new Map<
    string,
    { readonly commit: string; readonly at: Map<string, Promise<string | null>> }
  >();
  const lastCommitted = (repoPath: string, commit: string, paths: readonly string[]) => {
    let atHead = committed.get(repoPath);
    if (atHead?.commit !== commit) {
      atHead = { commit, at: new Map() };
      committed.set(repoPath, atHead);
    }
    const key = paths.join('\0');
    const kept = atHead.at.get(key);
    if (kept !== undefined) return kept;
    const at = deps.git.lastChangedAt(repoPath, paths.map(literalGlob)).catch(() => {
      atHead.at.delete(key);
      return null;
    });
    atHead.at.set(key, at);
    return at;
  };
  /** When each suite with a run and a named definition last had that definition committed. */
  async function definitionTimes(
    repoPath: string,
    read: FoundEvals | null,
    manifest: ReturnType<typeof readEvalManifest>,
  ): Promise<DefinitionTimes> {
    const times = new Map<string, string>();
    if (read === null) return times;
    for (const suite of buildEvals(read, manifest).suites) {
      if (suite.latest === null || suite.definitionPaths.length === 0) continue;
      const at = await lastCommitted(repoPath, read.commit, suite.definitionPaths);
      if (at !== null) times.set(suite.key, at);
    }
    return times;
  }
  const siteReads = keptByCommit<FoundCallSites | null>();
  const fileReads = keptByCommit<ReadonlySet<string>>();
  // A read that failed (a timeout, a refused pin) rejects and is not kept; only an answer git gave is.
  const sitesAt = (repoPath: string, commit: string, manifest: StoredEvalManifest) => {
    const patterns = patternsOf(manifest);
    return siteReads(`${repoPath}\0${commit}\0${JSON.stringify(patterns)}`, () =>
      findCallSites(deps.git, repoPath, commit, patterns),
    ).catch(() => null);
  };
  const filesAt = (repoPath: string, commit: string) =>
    fileReads(`${repoPath}\0${commit}`, () =>
      deps.git.filesAt(repoPath, commit).then((files): ReadonlySet<string> => new Set(files)),
    ).catch(() => null);
  /**
   * The assessed commit's sites, to tell HEAD's new ones from; null when either read is missing or stopped
   * at the cap, where a site past it would look new.
   */
  async function sitesThen(
    repoPath: string,
    since: string,
    manifest: StoredEvalManifest,
    now: FoundCallSites | null,
  ): Promise<readonly CallSite[] | null> {
    if (now === null || now.counts.some((c) => c.capped)) return null;
    const then = await sitesAt(repoPath, since, manifest);
    return then === null || then.counts.some((c) => c.capped) ? null : then.sites;
  }
  /** The manifest's call sites at HEAD, and what changed since the commit it read. */
  async function discover(
    repoPath: string,
    read: FoundEvals | null,
    manifest: StoredEvalManifest | null,
  ): Promise<Discovery | null> {
    if (read === null || manifest === null) return null;
    const now = await sitesAt(repoPath, read.commit, manifest);
    const definitions = read.markers.definitions;
    const uncovered = now === null ? [] : uncoveredSites(now.sites, manifest, definitions);
    const since = manifest.commit;
    let drift = null;
    if (since !== null && since !== read.commit) {
      const linked = new Set(manifest.manifest.suites.flatMap((s) => s.definitionPaths));
      drift = evalDrift({
        since,
        unlinked: definitions.filter((p) => !linked.has(p)),
        filesThen: await filesAt(repoPath, since),
        uncoveredNow: uncovered,
        sitesThen: await sitesThen(repoPath, since, manifest, now),
        missingPaths: untrackedIn(manifest.manifest, read),
      });
    }
    return { counts: now?.counts ?? [], uncovered, drift };
  }
  return {
    async read(projectId, repoPath) {
      const read = await found(repoPath);
      const manifest = readEvalManifest(deps.state.db, projectId);
      return buildEvals(
        read,
        manifest,
        await definitionTimes(repoPath, read, manifest),
        await discover(repoPath, read, manifest),
      );
    },
    async models(projectId, repoPath) {
      return buildModels(await found(repoPath), readEvalManifest(deps.state.db, projectId));
    },
    async candidateBasis(projectId, repoPath, key) {
      const suite = readEvalManifest(deps.state.db, projectId)?.manifest.suites.find(
        (s) => s.key === key,
      );
      if (suite === undefined) throw new NotFoundError('Eval suite', key);
      const read = await found(repoPath);
      return {
        models: suite.live?.models ?? null,
        runs: read?.suites.find((s) => s.key === key)?.runs ?? [],
      };
    },
    async suite(projectId, repoPath, key, run) {
      const read = await found(repoPath);
      const manifest = readEvalManifest(deps.state.db, projectId);
      const result = buildSuiteDetail(
        read,
        manifest,
        key,
        run,
        await definitionTimes(repoPath, read, manifest),
      );
      if (result.kind === 'no_suite') throw new NotFoundError('Eval suite', key);
      if (result.kind === 'no_run') throw new NotFoundError('Eval run', run ?? '');
      return result.detail;
    },
    async standing(repoPath, queries) {
      const read = await found(repoPath);
      return queries.map((q) => {
        const runs = read?.suites.find((s) => s.key === q.key)?.runs ?? [];
        const { state, before, after } = coverageOf({ runs, baseAt: q.baseAt, headAt: q.headAt });
        return {
          state,
          before: before === null ? null : sideOf(before),
          after: after === null ? null : sideOf(after),
        };
      });
    },
    async draftTask(projectId, repoPath, request) {
      const read = await found(repoPath);
      const manifest = readEvalManifest(deps.state.db, projectId);
      const suites = buildEvals(read, manifest).suites;
      const skills = read === null ? [] : await findEvalSkills(deps.git, repoPath, read.tracked);
      return evalTaskDraft(request, skills, suites);
    },
    async draftSwitch(projectId, repoPath, key, request) {
      const read = await found(repoPath);
      const manifest = readEvalManifest(deps.state.db, projectId);
      const suites = buildEvals(read, manifest).suites;
      const suite = suites.find((s) => s.key === key);
      if (suite === undefined) throw new NotFoundError('Eval suite', key);
      const skills = read === null ? [] : await findEvalSkills(deps.git, repoPath, read.tracked);
      return {
        ...switchTaskDraft(suite, request, suites, skills),
        coveredPaths: manifest?.manifest.suites.find((s) => s.key === key)?.coveredPaths ?? [],
      };
    },
    async record(projectId, repoPath, manifest, source = EvalManifestSource.Agent) {
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
      const missingEnv = await missingEnvFiles(manifest, repoPath);
      if (missingEnv.length > 0) {
        return {
          ok: false,
          untracked: missingEnv,
          message: `Not a regular file in the checkout (no link), so nothing was recorded: ${missingEnv.join(', ')}`,
        };
      }
      const stored = { manifest, source, commit: read.commit, assessedAt: deps.state.now() };
      deps.state.write((ctx) => {
        writeEvalManifest(ctx, projectId, stored);
      });
      return {
        ok: true,
        evals: buildEvals(
          read,
          stored,
          await definitionTimes(repoPath, read, stored),
          await discover(repoPath, read, stored),
        ),
      };
    },
  };
}
