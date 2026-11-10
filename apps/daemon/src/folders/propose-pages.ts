import {
  AreaRole,
  globsOverlap,
  InvalidError,
  type AreaDef,
  type PagesProposalDto,
  type ProjectDto,
  type ProposedArea,
} from '@10db/contracts';
import { proposeAreas, type ProposeAreasDeps } from './propose-areas';

// Workbench spec §4.2, §7.1: a project with no page area, or too few, asks the area proposer for the
// pages it can add, each beside the areas it has.

/** The globs two areas share a file under, or null; a catch-all shares none. */
function sharedGlobs(one: AreaDef, other: AreaDef): readonly [string, string] | null {
  if (one.catchAll === true || other.catchAll === true) return null;
  for (const mine of one.globs) {
    const theirs = other.globs.find((g) => globsOverlap(mine, g));
    if (theirs !== undefined) return [mine, theirs];
  }
  return null;
}

const sameGlobs = (one: AreaDef, other: AreaDef): boolean =>
  one.globs.length === other.globs.length && one.globs.every((g) => other.globs.includes(g));

/** Why the proposed page can't be added beside `areas`, or null when it can. */
function whyLeftOut(
  proposed: ProposedArea,
  areas: readonly AreaDef[],
  hazards: readonly { readonly name: string }[],
): string | null {
  if (areas.some((a) => a.name === proposed.name))
    return `An area named "${proposed.name}" exists already`;
  if (hazards.some((h) => h.name === proposed.name))
    return `A hazard named "${proposed.name}" exists already`;
  const same = areas.find((a) => a.role !== AreaRole.Page && sameGlobs(a, proposed));
  if (same !== undefined)
    return `Area "${same.name}" holds these files; mark it a page in Settings › Areas and hazards instead`;
  for (const other of areas.filter((a) => a.role === AreaRole.Page)) {
    const shared = sharedGlobs(proposed, other);
    if (shared !== null)
      return `It shares files with page "${other.name}": ${shared[0]} and ${shared[1]} both match one`;
    if (proposed.route !== undefined && other.route === proposed.route)
      return `Page "${other.name}" shows ${proposed.route} already`;
  }
  return null;
}

/**
 * The proposer's pages that can be added to the project as it is, in its order, and each page left out
 * with why: a name an area or hazard has, the files of an area that is not a page, files another page
 * holds (one the project has, or one kept before it here), or a route another page shows. What is not
 * a page is left out unsaid. Pure.
 */
export function keepPageProposals(
  proposed: readonly ProposedArea[],
  project: Pick<ProjectDto, 'areas' | 'hazards'>,
): PagesProposalDto {
  const pages: ProposedArea[] = [];
  const skipped: PagesProposalDto['skipped'] = [];
  for (const area of proposed.filter((a) => a.role === AreaRole.Page)) {
    const reason = whyLeftOut(area, [...project.areas, ...pages], project.hazards);
    if (reason === null) pages.push(area);
    else skipped.push({ name: area.name, reason });
  }
  return { pages, skipped };
}

/**
 * Propose Page Areas: the area proposer run over the project's repository, kept to the pages it can
 * add (`keepPageProposals`). A proposal the proposer refuses is refused with its words.
 */
export async function proposePageAreas(
  deps: ProposeAreasDeps,
  project: Pick<ProjectDto, 'repoPath' | 'areas' | 'hazards'>,
  signal?: AbortSignal,
): Promise<PagesProposalDto> {
  const result = await proposeAreas(deps, project.repoPath, signal);
  if (!result.ok) throw new InvalidError(result.message);
  return keepPageProposals(result.proposal.areas, project);
}
