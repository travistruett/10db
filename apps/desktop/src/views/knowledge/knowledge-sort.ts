import type { DataTableSortStatus } from 'mantine-datatable';

/** How one sortable column compares two records; the direction is applied by `sortRows`. */
export type Comparators<T> = Readonly<Partial<Record<string, (a: T, b: T) => number>>>;

/**
 * The rows in the order the table asks for. A column with no comparator keeps the daemon's order, and
 * so does a search the builder has not re-sorted: the best match leads.
 */
export function sortRows<T>(
  rows: readonly T[],
  sort: DataTableSortStatus<T> | null,
  comparators: Comparators<T>,
): T[] {
  if (sort === null) return [...rows];
  const compare = comparators[String(sort.columnAccessor)];
  if (!compare) return [...rows];
  const sign = sort.direction === 'asc' ? 1 : -1;
  return rows.toSorted((a, b) => sign * compare(a, b));
}
