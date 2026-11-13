import { ActionIcon, Group, Popover, Text, UnstyledButton } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconArrowDown,
  IconArrowUp,
  IconFilter,
  IconFilterFilled,
  IconSelector,
} from '@tabler/icons-react';
import type { DataTableColumn, DataTableSortStatus } from 'mantine-datatable';
import type { ReactNode } from 'react';

const DIRECTION_WORDS = { asc: 'ascending', desc: 'descending' } as const;

/**
 * A column's header when it sorts or filters: a sort button and a filter button side by side, each named.
 * mantine-datatable makes a sortable header cell itself a button and leaves its filter button unnamed
 * inside it, which assistive tech can neither name nor reach.
 */
function ColumnHeader<T>({
  title,
  accessor,
  sortable,
  sort,
  onSort,
  filter,
  filtering,
  alignEnd,
}: {
  readonly title: string;
  readonly accessor: DataTableSortStatus<T>['columnAccessor'];
  readonly sortable: boolean;
  readonly sort: DataTableSortStatus<T>;
  readonly onSort: (next: DataTableSortStatus<T>) => void;
  readonly filter: DataTableColumn<T>['filter'];
  readonly filtering: boolean;
  /** A right-aligned column, such as a number, keeps its title over its values. */
  readonly alignEnd: boolean;
}) {
  const [opened, { close, toggle }] = useDisclosure(false);
  const sorted = sort.columnAccessor === accessor ? sort.direction : null;
  const SortIcon =
    sorted === 'asc' ? IconArrowUp : sorted === 'desc' ? IconArrowDown : IconSelector;
  const FilterIcon = filtering ? IconFilterFilled : IconFilter;
  return (
    <Group gap={4} wrap="nowrap" justify={alignEnd ? 'flex-end' : 'space-between'}>
      {sortable ? (
        <UnstyledButton
          aria-label={
            sorted === null ? `Sort by ${title}` : `Sort by ${title}, ${DIRECTION_WORDS[sorted]}`
          }
          onClick={() => {
            // A sorted column flips; another keeps the direction the list is in.
            onSort({
              columnAccessor: accessor,
              direction: sorted === null ? sort.direction : sorted === 'asc' ? 'desc' : 'asc',
            });
          }}
          style={{ minWidth: 0 }}
        >
          <Group gap={4} wrap="nowrap">
            <Text inherit truncate>
              {title}
            </Text>
            <SortIcon size={14} stroke={1.5} aria-hidden opacity={sorted === null ? 0.4 : 1} />
          </Group>
        </UnstyledButton>
      ) : (
        <Text inherit truncate>
          {title}
        </Text>
      )}
      {filter === undefined ? null : (
        <Popover
          opened={opened}
          onChange={(next) => {
            if (!next) close();
          }}
          onClose={close}
          withArrow
          shadow="md"
          trapFocus
          // A filter stays open while the list it narrows changes under it; Mantine otherwise closes a
          // popover whose header it reads as out of view, mid-word.
          hideDetached={false}
        >
          <Popover.Target>
            <ActionIcon
              variant="default"
              size="sm"
              aria-label={`Filter ${title}`}
              data-active={filtering || undefined}
              onClick={toggle}
            >
              <FilterIcon size={14} stroke={1.5} />
            </ActionIcon>
          </Popover.Target>
          <Popover.Dropdown>
            {typeof filter === 'function' ? filter({ close }) : filter}
          </Popover.Dropdown>
        </Popover>
      )}
    </Group>
  );
}

/**
 * The column as the table draws it: a column that sorts or filters gets a `ColumnHeader` for its title,
 * and mantine-datatable's own sorting and filter are turned off for it.
 */
export function withColumnHeader<T>(
  column: DataTableColumn<T>,
  sort: DataTableSortStatus<T>,
  onSort: (next: DataTableSortStatus<T>) => void,
): DataTableColumn<T> {
  const sortable = column.sortable === true;
  if (!sortable && column.filter === undefined) return column;
  const title = typeof column.title === 'string' ? column.title : String(column.accessor);
  const header: ReactNode = (
    <ColumnHeader<T>
      title={title}
      accessor={column.accessor}
      sortable={sortable}
      sort={sort}
      onSort={onSort}
      filter={column.filter}
      filtering={column.filtering === true}
      alignEnd={column.textAlign === 'right'}
    />
  );
  const drawn: DataTableColumn<T> = { ...column, title: header, sortable: false };
  delete drawn.filter;
  delete drawn.filtering;
  delete drawn.filterPopoverProps;
  return drawn;
}
