import { ModelStatus, ModelTier, type AccountId, type ModelRowDto } from '@10db/contracts';

/** The columns of the model list that can order it. */
export const ModelColumn = {
  Name: 'name',
  Tier: 'tier',
  Intelligence: 'intelligence',
  CostPerTask: 'cost',
  StepsRun: 'steps',
} as const;
export type ModelColumn = (typeof ModelColumn)[keyof typeof ModelColumn];

export const SortDirection = { Ascending: 'asc', Descending: 'desc' } as const;
export type SortDirection = (typeof SortDirection)[keyof typeof SortDirection];

export interface ModelSort {
  readonly column: ModelColumn;
  readonly direction: SortDirection;
}

export interface ModelFilter {
  /** Words the name or model ID holds, in any case; blank keeps every model. */
  readonly query: string;
  /** The tiers kept; none keeps every tier, models with no tier included. */
  readonly tiers: readonly ModelTier[];
  /** The account the page is on, which keeps only the models it offers; null keeps every account's. */
  readonly accountId: AccountId | null;
}

/** A model first seen within this long is marked New. */
export const NEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const TIER_RANK: Readonly<Record<ModelTier, number>> = {
  [ModelTier.Efficient]: 0,
  [ModelTier.Balanced]: 1,
  [ModelTier.Capable]: 2,
  [ModelTier.Frontier]: 3,
};

/** What a row is ordered by in a column; null when it has no data there. */
function valueOf(row: ModelRowDto, column: ModelColumn): string | number | null {
  switch (column) {
    case ModelColumn.Name:
      return row.name.toLowerCase();
    case ModelColumn.Tier:
      return row.tier === null ? null : TIER_RANK[row.tier];
    case ModelColumn.Intelligence:
      return row.intelligence;
    case ModelColumn.CostPerTask:
      return row.costPerTaskUsd;
    case ModelColumn.StepsRun:
      return row.stepsRun;
  }
}

const compare = (a: string | number, b: string | number): number =>
  typeof a === 'string' || typeof b === 'string' ? String(a).localeCompare(String(b)) : a - b;

/**
 * The rows in the order asked. A row with no data in the column comes after the rows with data in either
 * direction, and an Unknown model comes after every other whatever the column and direction.
 */
export function sortModels(rows: readonly ModelRowDto[], sort: ModelSort): ModelRowDto[] {
  const sign = sort.direction === SortDirection.Ascending ? 1 : -1;
  const unknown = (row: ModelRowDto) => (row.status === ModelStatus.Unknown ? 1 : 0);
  return [...rows].sort((a, b) => {
    if (unknown(a) !== unknown(b)) return unknown(a) - unknown(b);
    const left = valueOf(a, sort.column);
    const right = valueOf(b, sort.column);
    if (left === null || right === null) {
      if (left === right) return a.name.localeCompare(b.name);
      return left === null ? 1 : -1;
    }
    return sign * (compare(left, right) || a.name.localeCompare(b.name));
  });
}

export function filterModels(rows: readonly ModelRowDto[], filter: ModelFilter): ModelRowDto[] {
  const query = filter.query.trim().toLowerCase();
  return rows.filter(
    (row) =>
      (query === '' ||
        row.name.toLowerCase().includes(query) ||
        row.model.toLowerCase().includes(query)) &&
      (filter.tiers.length === 0 || (row.tier !== null && filter.tiers.includes(row.tier))) &&
      (filter.accountId === null || row.availableOn.includes(filter.accountId)),
  );
}

/** The earliest first-seen time of any model, in ms; null when no model has one. */
export function earliestFirstSeen(rows: readonly ModelRowDto[]): number | null {
  const times = rows.flatMap((r) => (r.firstSeenAt === null ? [] : [Date.parse(r.firstSeenAt)]));
  return times.length === 0 ? null : Math.min(...times);
}

/** A model first seen after the first batch is news only that long after it. */
const FIRST_BATCH_MS = 24 * 60 * 60 * 1000;

/**
 * Whether the model is new: first seen within the last seven days and more than a day after the earliest
 * first-seen time of any model, so the models a builder sees on a fresh install are never news.
 */
export function isNewModel(row: ModelRowDto, now: number, earliest: number | null): boolean {
  if (row.firstSeenAt === null || earliest === null) return false;
  const seen = Date.parse(row.firstSeenAt);
  return now - seen < NEW_WINDOW_MS && seen - earliest > FIRST_BATCH_MS;
}
