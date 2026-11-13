import type { PrincipleKind } from '@10db/contracts';
import { ActionIcon, Badge, Box, Checkbox, Group, Menu, Text, UnstyledButton } from '@mantine/core';
import { IconColumns3 } from '@tabler/icons-react';
import {
  DataTable,
  useDataTableColumns,
  type DataTableColumn,
  type DataTablePaginationProps,
  type DataTableSortStatus,
} from 'mantine-datatable';
import type { ReactNode } from 'react';
import { withColumnHeader } from '../../shell/column-header';
import { PRINCIPLE_KIND_COLORS, PRINCIPLE_KIND_LABELS } from './knowledge-labels';
import { PAGE_SIZES, type Paging } from './knowledge-paging';
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

/** One column the Columns menu can hide or show. */
interface ColumnChoice {
  readonly accessor: string;
  readonly title: ReactNode;
  readonly shown: boolean;
}

/** Hides and shows a list's columns; the choice is kept with the rest of its layout. */
function ColumnsMenu({
  choices,
  onToggle,
}: {
  readonly choices: readonly ColumnChoice[];
  readonly onToggle: (accessor: string) => void;
}) {
  if (choices.length === 0) return null;
  return (
    <Group justify="flex-end">
      <Menu position="bottom-end" closeOnItemClick={false} withinPortal>
        <Menu.Target>
          <ActionIcon variant="subtle" size="sm" aria-label="Columns">
            <IconColumns3 size={16} stroke={1.5} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Label>Columns</Menu.Label>
          {choices.map((c) => (
            <Menu.Item
              key={c.accessor}
              leftSection={
                <Checkbox size="xs" readOnly checked={c.shown} tabIndex={-1} aria-hidden />
              }
              onClick={() => {
                onToggle(c.accessor);
              }}
            >
              {c.title}
            </Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>
    </Group>
  );
}

/** The names of the pager's arrows, which Mantine leaves unnamed. */
const PAGER_CONTROLS: Readonly<Record<'first' | 'last' | 'previous' | 'next', string>> = {
  first: 'First page',
  last: 'Last page',
  previous: 'Previous page',
  next: 'Next page',
};

/** One page of a list as the daemon answered it, and how to ask for another. */
export interface TablePage extends Paging {
  /** How many records the list holds on every page together. */
  readonly total: number;
}

/** The pager under a list with a daemon page and at least one record; none otherwise. */
function pagerProps(paging: TablePage | undefined): DataTablePaginationProps {
  if (paging === undefined || paging.total === 0) return {};
  return {
    totalRecords: paging.total,
    recordsPerPage: paging.pageSize,
    page: paging.page,
    onPageChange: paging.onPage,
    recordsPerPageOptions: [...PAGE_SIZES],
    onRecordsPerPageChange: paging.onPageSize,
    recordsPerPageLabel: 'Per page',
    paginationText: ({ from, to, totalRecords }) =>
      `${String(from)}–${String(to)} of ${String(totalRecords)}`,
    getPaginationControlProps: (control) => ({ 'aria-label': PAGER_CONTROLS[control] }),
    getPaginationItemProps: (page) => ({ 'aria-label': `Page ${String(page)}` }),
  };
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
  const off = new Set(columnsToggle.filter((t) => !t.toggled).map((t) => t.accessor));
  const stored = new Map(effectiveColumns.map((c) => [String(c.accessor), c]));
  const choices: ColumnChoice[] = columns
    .filter((c) => c.toggleable === true)
    .map((c) => ({
      accessor: String(c.accessor),
      title: c.title ?? String(c.accessor),
      shown: !off.has(String(c.accessor)),
    }));
  const toggle = (accessor: string): void => {
    const known = columnsToggle.some((t) => t.accessor === accessor);
    setColumnsToggle(
      known
        ? columnsToggle.map((t) => (t.accessor === accessor ? { ...t, toggled: !t.toggled } : t))
        : [...columnsToggle, { accessor, defaultToggle: true, toggleable: true, toggled: false }],
    );
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
      ? { ...drawn, title: <ColumnsMenu choices={choices} onToggle={toggle} /> }
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
      {...pagerProps(paging)}
    />
  );
}
