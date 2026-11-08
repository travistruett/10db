import {
  HazardRemoval,
  InboxKind,
  type HazardEntryKind,
  type InboxAnswer,
  type InboxItemDto,
  type InboxOption,
  type ProjectId,
} from '@10db/contracts';
import {
  applyHazardRemovals,
  findOpenByFoldKey,
  keepHazards,
  type DbReader,
  type Json,
  type WriteContext,
} from '@10db/db';
import { z } from 'zod';

const HAZARD_DETAIL = 'hazardRemovals';

/** The answers the card offers; it shows them as written. */
export const HazardChoice = {
  Remove: 'Remove them',
  Keep: 'Keep them',
} as const;
export type HazardChoice = (typeof HazardChoice)[keyof typeof HazardChoice];

/** The card is one per project: a later look replaces what it lists. */
export const hazardCardFoldKey = (projectId: ProjectId): string => `hazard-removals:${projectId}`;

const Removals = z.array(HazardRemoval);

const KIND_WORDS: Readonly<Record<HazardEntryKind, string>> = {
  glob: 'the path pattern',
  command: 'the command',
};

const where = (removal: HazardRemoval): string =>
  removal.evidence.line === undefined
    ? removal.evidence.file
    : `${removal.evidence.file} line ${String(removal.evidence.line)}`;

/** What the card says for one change: what leaves which hazard, why, and where 10db looked. */
function change(removal: HazardRemoval): string {
  return `• Stop counting ${KIND_WORDS[removal.kind]} ${removal.value} as "${removal.hazard}". ${removal.reason} (${where(removal)})`;
}

/** The flag card for the removals, ready for `flagCard`. */
export function hazardRemovalCard(
  project: { readonly id: ProjectId; readonly name: string },
  removals: readonly HazardRemoval[],
) {
  const options: InboxOption[] = [
    {
      label: HazardChoice.Remove,
      description: 'These stop being one-at-a-time, so tasks can run them side by side',
    },
    {
      label: HazardChoice.Keep,
      description: 'Leave the hazards as they are; 10db will not suggest these again',
    },
  ];
  return {
    projectId: project.id,
    workstreamId: null,
    title: `Loosen ${removals.length === 1 ? 'a hazard' : `${String(removals.length)} hazards`} in ${project.name}?`,
    body: [
      '10db read the repository again and found hazard entries it no longer sees a reason for. A hazard makes tasks take turns, so taking one out is only done with your yes.',
      ...removals.map(change),
    ].join('\n'),
    options,
    recommendation: null,
    detail: { [HAZARD_DETAIL]: removals as unknown as Json },
    foldKey: hazardCardFoldKey(project.id),
    refresh: true,
  };
}

function listed(detail: InboxItemDto['detail']): HazardRemoval[] {
  const parsed = Removals.safeParse(detail?.[HAZARD_DETAIL]);
  return parsed.success ? parsed.data : [];
}

/** The changes the project's open card is waiting on; none when there is no card. */
export function pendingHazardRemovals(db: DbReader, projectId: ProjectId): HazardRemoval[] {
  return listed(findOpenByFoldKey(db, projectId, hazardCardFoldKey(projectId))?.detail ?? null);
}

/**
 * Remove them on the card takes its entries out of their hazards in the answer's own transaction; Keep
 * them records that the builder wants them, so they are not listed again. Any other card is left alone.
 */
export function applyHazardChoice(
  ctx: WriteContext,
  item: InboxItemDto,
  answer: InboxAnswer,
): void {
  if (item.kind !== InboxKind.Flag || item.detail?.[HAZARD_DETAIL] === undefined) return;
  const removals = listed(item.detail);
  if (answer.choice === HazardChoice.Remove) applyHazardRemovals(ctx, item.projectId, removals);
  else if (answer.choice === HazardChoice.Keep) keepHazards(ctx, item.projectId, removals);
}
