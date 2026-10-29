import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { AreaProposalSource, type AreaProposalResult, type ProposedArea } from '@10db/contracts';
import { equalOrUnder, type Git } from '../git';
import { deriveAreaCandidates, mergeCoupledCandidates } from './area-candidates';
import { areasFromModel, areasFromStructure, namingPrompt } from './area-naming';

/** How many of the latest commits are read for files that change together. */
const HISTORY_COMMITS = 400;

/**
 * Asks a model one question and returns its text. The prompt carries paths from the repository as
 * data; the model gets no tool and no file, so it can read and run nothing of the repository's.
 */
export type AreaNamer = (prompt: string) => Promise<string>;

export interface ProposeAreasDeps {
  readonly git: Git;
  /** Names and merges the candidates; null leaves them named from their paths. */
  readonly namer: AreaNamer | null;
  /** The data dir, the lane temp root and the worktree root: 10db's own places. */
  readonly protectedRoots: readonly string[];
}

const refuse = (message: string): AreaProposalResult => ({ ok: false, message });

function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

async function named(
  namer: AreaNamer | null,
  candidates: Parameters<typeof namingPrompt>[0],
): Promise<{ areas: ProposedArea[]; source: AreaProposalSource }> {
  if (namer !== null) {
    try {
      const areas = areasFromModel(await namer(namingPrompt(candidates)), candidates);
      if (areas !== null) return { areas, source: AreaProposalSource.Model };
    } catch {
      // A model that is unavailable or slow costs the builder the names, not the proposal.
    }
  }
  return { areas: areasFromStructure(candidates), source: AreaProposalSource.Structure };
}

/**
 * Areas for the repository at `path`, each with its globs and a one-line reason. The signals are the
 * tracked files at HEAD and the files that changed together in recent commits, both read through git's
 * plumbing; no file in the checkout is opened and no program the repository names is run. A model then
 * names and merges the candidates, and when it is absent or answers badly they are named from their
 * paths. The same function serves a new project and, later, Settings.
 */
export async function proposeAreas(
  deps: ProposeAreasDeps,
  path: string,
): Promise<AreaProposalResult> {
  const given = realOrResolved(path);
  if (deps.protectedRoots.some((p) => equalOrUnder(given, realOrResolved(p))))
    return refuse('10db keeps its own files here; choose another folder.');

  const survey = await deps.git.survey(given, HISTORY_COMMITS);
  if ('refused' in survey)
    return refuse(
      survey.refused === 'not_a_repository'
        ? "This folder isn't a git repository."
        : survey.refused === 'bare_repository'
          ? 'This is a bare repository; choose a checkout.'
          : survey.message,
    );

  const candidates = mergeCoupledCandidates(deriveAreaCandidates(survey.files), survey.commits);
  const { areas, source } = await named(deps.namer, candidates);
  return { ok: true, proposal: { areas, namedBy: source } };
}
