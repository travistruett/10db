import { Box, Text } from '@mantine/core';
import { DataTable, type DataTableColumn, type DataTableSortStatus } from 'mantine-datatable';
import type { KeyboardEvent, ReactNode } from 'react';
import { withColumnHeader } from '../../shell/column-header';
import { pagerProps, TABLE_PAGE_SIZES, type TablePage } from '../../shell/table-pager';
import { RowKeyAction, rowKeyAction } from './row-keys';
import { KEYS_IGNORE_ATTRIBUTE } from './use-inbox-keys';

/** The attribute naming a row's record, which the arrow keys find the next and previous row by. */
const ROW_ID_ATTRIBUTE = 'data-row-id';

/** A cell whose clicks and keys stay in it, so a menu or a button in it never opens or closes the row. */
export function ActionsCell({ children }: { readonly children: ReactNode }) {
  return (
    <Box
      onClick={(event) => {
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
      }}
    >
      {children}
    </Box>
  );
}

/** Focus the row `step` rows from `row`, skipping the rows an expanded record opens under it. */
function focusSibling(row: HTMLElement, step: number): void {
  const body = row.closest('tbody');
  if (body === null) return;
  const rows = [...body.querySelectorAll<HTMLElement>(`tr[${ROW_ID_ATTRIBUTE}]`)];
  rows[rows.indexOf(row) + step]?.focus();
}

/**
 * One of the Inbox's paged lists as a table. The daemon filters, sorts and pages it: `records` is one
 * page and the pager below asks for another. A column that sorts or filters draws its header with
 * `withColumnHeader`. A row opens to show `detail` on a click, or with the keyboard on the focused row
 * (`rowKeyAction`: Enter, → and ←, with ↓ and ↑ to move). Which rows are open is the caller's, so a
 * row's menu can open it too.
 */
export function InboxTable<T extends { readonly id: string }>({
  label,
  records,
  columns,
  sort,
  onSort,
  paging,
  fetching,
  empty,
  expanded,
  onExpanded,
  detail,
}: {
  readonly label: string;
  readonly records: readonly T[];
  readonly columns: DataTableColumn<T>[];
  readonly sort: DataTableSortStatus<T>;
  readonly onSort: (next: DataTableSortStatus<T>) => void;
  readonly paging: TablePage | undefined;
  readonly fetching: boolean;
  readonly empty: ReactNode;
  readonly expanded: readonly string[];
  readonly onExpanded: (ids: string[]) => void;
  readonly detail: (record: T) => ReactNode;
}) {
  const setOpen = (id: string, open: boolean): void => {
    onExpanded(open ? [...expanded.filter((e) => e !== id), id] : expanded.filter((e) => e !== id));
  };
  const onRowKey = (record: T, event: KeyboardEvent<HTMLElement>): void => {
    // Keys typed in the row's own controls, or in what it opened, are theirs.
    if (event.target !== event.currentTarget) return;
    const action = rowKeyAction(event.key, expanded.includes(record.id));
    if (action === null) return;
    event.preventDefault();
    switch (action) {
      case RowKeyAction.Expand:
        setOpen(record.id, true);
        return;
      case RowKeyAction.Collapse:
        setOpen(record.id, false);
        return;
      case RowKeyAction.Next:
        focusSibling(event.currentTarget, 1);
        return;
      case RowKeyAction.Previous:
        focusSibling(event.currentTarget, -1);
        return;
    }
  };
  return (
    // The Inbox's own keys answer Open's cards; in a table they would act on a card it does not show.
    <Box {...{ [KEYS_IGNORE_ATTRIBUTE]: true }}>
      <DataTable<T>
        aria-label={label}
        records={[...records]}
        columns={columns.map((c) => withColumnHeader(c, sort, onSort))}
        idAccessor="id"
        withTableBorder
        borderRadius="md"
        verticalSpacing="sm"
        horizontalSpacing="md"
        highlightOnHover
        fetching={fetching}
        {...(records.length === 0 ? { minHeight: 160 } : {})}
        emptyState={
          <Text c="dimmed" size="sm" ta="center" maw={420}>
            {empty}
          </Text>
        }
        rowExpansion={{
          allowMultiple: true,
          expanded: {
            recordIds: [...expanded],
            onRecordIdsChange: (ids: unknown[]) => {
              onExpanded(ids.map(String));
            },
          },
          content: ({ record }) => detail(record),
        }}
        customRowAttributes={(record) => ({
          tabIndex: 0,
          'aria-expanded': expanded.includes(record.id),
          [ROW_ID_ATTRIBUTE]: record.id,
          onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
            onRowKey(record, event);
          },
        })}
        {...pagerProps(paging, TABLE_PAGE_SIZES)}
      />
    </Box>
  );
}
