import { KNOWLEDGE_PAGE_SIZE, SortDirection, type KnowledgeSort } from '@10db/contracts';
import type { DataTableSortStatus } from 'mantine-datatable';
import type { KnowledgePageRequest } from '../../daemon/knowledge-queries';

/** The page sizes a list offers; the daemon answers at most the largest. */
export const PAGE_SIZES = [KNOWLEDGE_PAGE_SIZE, 50, 100];

/** The list route's sort for a column the table sorts, by the column's accessor. */
export type SortColumns = Readonly<Partial<Record<string, KnowledgeSort>>>;

/** What the table's sort asks the daemon for; null for no sort or a column the daemon can't sort by. */
export function orderOf<T>(
  sort: DataTableSortStatus<T> | null,
  columns: SortColumns,
): KnowledgePageRequest['sort'] {
  const by = sort === null ? undefined : columns[String(sort.columnAccessor)];
  if (sort === null || by === undefined) return null;
  return { by, dir: sort.direction === 'asc' ? SortDirection.Asc : SortDirection.Desc };
}
