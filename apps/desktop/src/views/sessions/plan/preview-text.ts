import type { ShapePreviewDto } from '@10db/contracts';

// Shape spec §10.2: the preview's words. Hours read as "1.5 h", a whole number without a decimal.

/** Hours to one decimal, with no trailing ".0". */
export function hoursText(hours: number): string {
  return `${String(Math.round(hours * 10) / 10)} h`;
}

const count = (n: number, noun: string): string => `${String(n)} ${noun}${n === 1 ? '' : 's'}`;

/**
 * What the landings save (spec §10.4): "4 pull requests instead of 9 · 4 CI runs instead of 9", or
 * the plain counts when no landing saves any.
 */
export function landingsLine(landings: ShapePreviewDto['landings']): string {
  const saves = landings.pullRequests < landings.pullRequestsAlone;
  return saves
    ? `${count(landings.pullRequests, 'pull request')} instead of ${String(landings.pullRequestsAlone)} · ${count(landings.ciRuns, 'CI run')} instead of ${String(landings.ciRunsAlone)}`
    : `${count(landings.pullRequests, 'pull request')} · ${count(landings.ciRuns, 'CI run')}`;
}

/** The folded line: "4 tasks · ~2 h · 4 pull requests". */
export function foldedSummary(preview: ShapePreviewDto): string {
  return [
    count(preview.tasks, 'task'),
    `~${hoursText(preview.totalLaneHours)}`,
    count(preview.landings.pullRequests, 'pull request'),
  ].join(' · ');
}
