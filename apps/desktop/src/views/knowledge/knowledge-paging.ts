import { KNOWLEDGE_PAGE_SIZE, SortDirection, type KnowledgeSort } from '@10db/contracts';
import type { DataTableSortStatus } from 'mantine-datatable';
import { useState } from 'react';
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

export interface Paging {
  readonly page: number;
  readonly pageSize: number;
  readonly onPage: (page: number) => void;
  readonly onPageSize: (pageSize: number) => void;
}

/**
 * The page a list shows. It goes back to the first page whenever `listed` changes (the filters, search,
 * shelf or sort that say what the list holds), and when the page size changes.
 */
export function usePaging(listed: string): Paging {
  const [state, setState] = useState({ listed, page: 1, pageSize: KNOWLEDGE_PAGE_SIZE });
  return {
    page: state.listed === listed ? state.page : 1,
    pageSize: state.pageSize,
    onPage: (page) => {
      setState({ listed, page, pageSize: state.pageSize });
    },
    onPageSize: (pageSize) => {
      setState({ listed, page: 1, pageSize });
    },
  };
}
