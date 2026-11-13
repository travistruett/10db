import type { PrincipleKind } from '@10db/contracts';
import { Badge, Box, Group, Text, UnstyledButton } from '@mantine/core';
import {
  DataTable,
  useDataTableColumns,
  type DataTableColumn,
  type DataTableSortStatus,
} from 'mantine-datatable';
import type { ReactNode } from 'react';
import { withColumnHeader } from '../../shell/column-header';
import { columnChoices, ColumnsMenu, hiddenColumns, toggleColumn } from '../../shell/columns-menu';
import { PRINCIPLE_KIND_COLORS, PRINCIPLE_KIND_LABELS } from './knowledge-labels';
import { pagerProps, type TablePage } from '../../shell/table-pager';
import { PAGE_SIZES } from './knowledge-paging';
import './knowledge-table.css';

/** The accessor of a list's last column, the row's menu, whose header holds the Columns menu. */
export const ACTIONS_COLUMN = 'actions';

export function KindBadge({ kind }: { readonly kind: PrincipleKind }) {
  return (
    <Badge size="sm" variant="light" color={PRINCIPLE_KIND_COLORS[kind]}>
      {PRINCIPLE_KIND_LABELS[kind]}
    </Badge>
  );
}

/** A row's text, which opens where the record came from: the keyboard's way to what a row click does. */
export function OpenRecordText({
  label,
  children,
  onOpen,
}: {
  /** The record's words, which the button's name carries. */
  readonly label: string;
  readonly children: ReactNode;
  readonly onOpen: () => void;
}) {
  return (
    <UnstyledButton
      aria-label={`Where ${label} came from`}
      onClick={(event) => {
        // The row's own click does the same; one opening is enough.
        event.stopPropagation();
        onOpen();
      }}
      style={{ textAlign: 'left' }}
    >
      <Text size="sm">{children}</Text>
    </UnstyledButton>
  );
}

/** A cell whose clicks stay in it, so a menu or a button in it never opens the row. */
export function ActionsCell({ children }: { readonly children: ReactNode }) {
  return (
    <Box
      onClick={(event) => {
        event.stopPropagation();
      }}
    >
      {children}
    </Box>
  );
}

/**
 * A Knowledge list as a table. Columns resize and sort, the first column's and Scope's filters narrow it
 * (`withColumnHeader` draws the headers that sort or filter),
 * the Columns menu in the corner hides and shows columns, and the layout is kept per list in the window's
 * storage under `storeKey`. Clicking a row opens it. The daemon sorts and pages it: `records` is one page
 * and the pager below asks for another. An empty list still draws its header, so its filters stay in
 * reach, and says `empty` in its body.
 */
export function KnowledgeTable<T>({
  label,
  storeKey,
  records,
  columns,
  idOf,
  onOpen,
  sort,
  onSort,
  paging,
  empty,
}: {
  readonly label: string;
  readonly storeKey: string;
  readonly records: readonly T[];
  readonly columns: DataTableColumn<T>[];
  readonly idOf: (record: T) => string;
  readonly onOpen?: (record: T) => void;
  readonly sort: DataTableSortStatus<T>;
  readonly onSort: (next: DataTableSortStatus<T>) => void;
  /** The daemon's page; without one the table lists every record it is given. */
  readonly paging?: TablePage;
  readonly empty: ReactNode;
}) {
  const { effectiveColumns, columnsToggle, setColumnsToggle } = useDataTableColumns<T>({
    key: storeKey,
    columns,
  });
  // The stored layout knows only the columns it has seen, and the hook drops or hides any other, such as
  // State when Past is chosen. So the list's own columns are drawn, with the stored widths, and a column
  // hides only when the builder switched it off.
  const off = hiddenColumns(columns, columnsToggle);
  const stored = new Map(effectiveColumns.map((c) => [String(c.accessor), c]));
  const choices = columnChoices(columns, columnsToggle);
  const toggle = (accessor: string): void => {
    setColumnsToggle(toggleColumn(columns, columnsToggle, accessor));
  };
  const shown = columns.map((c): DataTableColumn<T> => {
    const accessor = String(c.accessor);
    const width = stored.get(accessor)?.width ?? c.width;
    // The Columns menu hides and shows columns, so mantine-datatable's own unnamed hide button is left off.
    const drawn = {
      ...withColumnHeader(c, sort, onSort),
      ...(width === undefined ? {} : { width }),
      hidden: c.toggleable === true && off.has(accessor),
      toggleable: false,
    };
    return accessor === ACTIONS_COLUMN
      ? {
          ...drawn,
          title: (
            <Group justify="flex-end">
              <ColumnsMenu choices={choices} onToggle={toggle} />
            </Group>
          ),
        }
      : drawn;
  });
  return (
    <DataTable<T>
      aria-label={label}
      storeColumnsKey={storeKey}
      records={[...records]}
      columns={shown}
      idAccessor={idOf}
      withTableBorder
      borderRadius="md"
      verticalSpacing="sm"
      horizontalSpacing="md"
      highlightOnHover
      {...(records.length === 0 ? { minHeight: 160 } : {})}
      emptyState={
        <Text c="dimmed" size="sm" ta="center" maw={420}>
          {empty}
        </Text>
      }
      {...(onOpen
        ? {
            onRowClick: ({ record }: { record: T }) => {
              onOpen(record);
            },
          }
        : {})}
      {...pagerProps(paging, PAGE_SIZES)}
    />
  );
}
