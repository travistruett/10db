import { KnowledgeState } from '@10db/contracts';

/**
 * Which records a list shows: principle proposals waiting on the builder, what is current, or what no
 * longer applies (superseded, retired or withdrawn). Decisions have no pending shelf.
 */
export const KnowledgeShelf = {
  Pending: 'pending',
  Current: 'current',
  Past: 'past',
} as const;
export type KnowledgeShelf = (typeof KnowledgeShelf)[keyof typeof KnowledgeShelf];

export const SHELF_LABELS: Readonly<Record<KnowledgeShelf, string>> = {
  [KnowledgeShelf.Pending]: 'Pending',
  [KnowledgeShelf.Current]: 'Current',
  [KnowledgeShelf.Past]: 'Past',
};

const PAST_STATES: readonly KnowledgeState[] = [
  KnowledgeState.Superseded,
  KnowledgeState.Retired,
  KnowledgeState.Withdrawn,
];

/** A record on the Past shelf: one that no longer applies. */
export function isPast(state: KnowledgeState): boolean {
  return PAST_STATES.includes(state);
}

const SHELVES: readonly string[] = Object.values(KnowledgeShelf);
export function isShelf(value: string): value is KnowledgeShelf {
  return SHELVES.includes(value);
}
