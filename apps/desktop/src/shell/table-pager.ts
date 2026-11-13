import type { DataTablePaginationProps } from 'mantine-datatable';

/** The names of the pager's arrows, which Mantine leaves unnamed. */
const PAGER_CONTROLS: Readonly<Record<'first' | 'last' | 'previous' | 'next', string>> = {
  first: 'First page',
  last: 'Last page',
  previous: 'Previous page',
  next: 'Next page',
};

/** One page of a list, and how to ask for another. */
export interface TablePage {
  readonly page: number;
  readonly pageSize: number;
  readonly onPage: (page: number) => void;
  readonly onPageSize: (pageSize: number) => void;
  /** How many records the list holds on every page together. */
  readonly total: number;
}

/** The pager under a list with at least one record, offering `sizes` a page; none otherwise. */
export function pagerProps(
  paging: TablePage | undefined,
  sizes: readonly number[],
): DataTablePaginationProps {
  if (paging === undefined || paging.total === 0) return {};
  return {
    totalRecords: paging.total,
    recordsPerPage: paging.pageSize,
    page: paging.page,
    onPageChange: paging.onPage,
    recordsPerPageOptions: [...sizes],
    onRecordsPerPageChange: paging.onPageSize,
    recordsPerPageLabel: 'Per page',
    // Counted from the page, not the rows drawn, so rows a page opens under its records don't move it.
    paginationText: () => {
      const from = (paging.page - 1) * paging.pageSize + 1;
      const to = Math.min(paging.page * paging.pageSize, paging.total);
      return `${String(from)}–${String(to)} of ${String(paging.total)}`;
    },
    getPaginationControlProps: (control) => ({ 'aria-label': PAGER_CONTROLS[control] }),
    getPaginationItemProps: (page) => ({ 'aria-label': `Page ${String(page)}` }),
  };
}
