import { ActionIcon, Checkbox, Menu } from '@mantine/core';
import { IconColumns3 } from '@tabler/icons-react';
import type { DataTableColumn, DataTableColumnToggle } from 'mantine-datatable';
import type { ReactNode } from 'react';

/** One column the Columns menu can hide or show. */
export interface ColumnChoice {
  readonly accessor: string;
  readonly title: ReactNode;
  readonly shown: boolean;
}

/** Whether a toggleable column is hidden: by the builder's switch, else by its default. */
function isOff<T>(column: DataTableColumn<T>, toggles: readonly DataTableColumnToggle[]): boolean {
  const kept = toggles.find((t) => t.accessor === String(column.accessor));
  return kept === undefined ? column.defaultToggle === false : !kept.toggled;
}

/** The accessors of the toggleable columns the builder has switched off, or that start off. */
export function hiddenColumns<T>(
  columns: readonly DataTableColumn<T>[],
  toggles: readonly DataTableColumnToggle[],
): ReadonlySet<string> {
  return new Set(
    columns
      .filter((c) => c.toggleable === true && isOff(c, toggles))
      .map((c) => String(c.accessor)),
  );
}

/** The columns the menu lists: every toggleable one, with whether it is drawn. */
export function columnChoices<T>(
  columns: readonly DataTableColumn<T>[],
  toggles: readonly DataTableColumnToggle[],
): ColumnChoice[] {
  return columns
    .filter((c) => c.toggleable === true)
    .map((c) => ({
      accessor: String(c.accessor),
      title: c.title ?? String(c.accessor),
      shown: !isOff(c, toggles),
    }));
}

/** The toggles after the builder flips one column. A column the stored layout has not seen is added. */
export function toggleColumn<T>(
  columns: readonly DataTableColumn<T>[],
  toggles: readonly DataTableColumnToggle[],
  accessor: string,
): DataTableColumnToggle[] {
  if (toggles.some((t) => t.accessor === accessor))
    return toggles.map((t) => (t.accessor === accessor ? { ...t, toggled: !t.toggled } : t));
  const column = columns.find((c) => String(c.accessor) === accessor);
  const defaultToggle = column?.defaultToggle ?? true;
  return [...toggles, { accessor, defaultToggle, toggleable: true, toggled: !defaultToggle }];
}

/** Hides and shows a table's columns; the choice is kept with the rest of its layout. */
export function ColumnsMenu({
  choices,
  onToggle,
}: {
  readonly choices: readonly ColumnChoice[];
  readonly onToggle: (accessor: string) => void;
}) {
  if (choices.length === 0) return null;
  return (
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
  );
}
