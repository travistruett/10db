import type { PrincipleKind } from '@10db/contracts';
import { ActionIcon, Badge, Box, Checkbox, Group, Menu, Text, UnstyledButton } from '@mantine/core';
import { IconColumns3 } from '@tabler/icons-react';
import {
  DataTable,
  useDataTableColumns,
  type DataTableColumn,
  type DataTableSortStatus,
} from 'mantine-datatable';
import type { ReactNode } from 'react';
import { PRINCIPLE_KIND_COLORS, PRINCIPLE_KIND_LABELS } from './knowledge-labels';
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

/**
 * A Knowledge list as a table. Columns resize and sort, the first column's and Scope's filters narrow it,
 * the Columns menu in the corner hides and shows columns, and the layout is kept per list in the window's
 * storage under `storeKey`. Clicking a row opens it. An empty list still draws its header, so its filters
 * stay in reach, and says `empty` in its body.
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
    const drawn = {
      ...c,
      ...(width === undefined ? {} : { width }),
      hidden: c.toggleable === true && off.has(accessor),
      // A filter stays open while the list it narrows changes under it; Mantine otherwise closes a
      // popover whose header it reads as out of view, mid-word.
      ...(c.filter === undefined
        ? {}
        : { filterPopoverProps: { hideDetached: false, ...c.filterPopoverProps } }),
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
      sortStatus={sort}
      onSortStatusChange={onSort}
    />
  );
}
