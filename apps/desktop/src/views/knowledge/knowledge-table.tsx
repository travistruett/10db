import type { PrincipleKind } from '@10db/contracts';
import { Badge, Box, Text, UnstyledButton } from '@mantine/core';
import {
  DataTable,
  useDataTableColumns,
  type DataTableColumn,
  type DataTableSortStatus,
} from 'mantine-datatable';
import type { ReactNode } from 'react';
import { PRINCIPLE_KIND_COLORS, PRINCIPLE_KIND_LABELS } from './knowledge-labels';

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
 * A Knowledge list as a table: columns can be resized, sorted and hidden (right-click
 * a header), and the layout is kept per list in the window's storage under `storeKey`. Clicking a row
 * opens it.
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
}: {
  readonly label: string;
  readonly storeKey: string;
  readonly records: readonly T[];
  readonly columns: DataTableColumn<T>[];
  readonly idOf: (record: T) => string;
  readonly onOpen?: (record: T) => void;
  readonly sort: DataTableSortStatus<T>;
  readonly onSort: (next: DataTableSortStatus<T>) => void;
}) {
  const { effectiveColumns } = useDataTableColumns<T>({ key: storeKey, columns });
  return (
    <DataTable<T>
      aria-label={label}
      storeColumnsKey={storeKey}
      records={[...records]}
      columns={effectiveColumns}
      idAccessor={idOf}
      withTableBorder
      borderRadius="md"
      verticalSpacing="sm"
      horizontalSpacing="md"
      highlightOnHover
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
