import { ShapeProposalState, type ShapeProposalDto, type ShapeTaskSizeDto } from '@10db/contracts';
import { ActionIcon, Box, Button, Group, Menu, Text, UnstyledButton } from '@mantine/core';
import { IconClockExclamation, IconDots, IconPencil, IconPin } from '@tabler/icons-react';
import { useRef, useState, type KeyboardEvent } from 'react';
import type { RowChange } from '../../daemon/shape-queries';
import { convertedLine, markText, proposalTitle, rowMeta } from './proposal-text';
import { RowDetails } from './row-details';
import { RowEditor } from './row-editor';
import { goalHoursLine, sizeLine } from './size-line';
import { editableFields } from './row-editing';

/** Marks a row's button, so ↑/↓ finds its siblings. */
export const ROW_ATTRIBUTE = 'data-shape-row';

/** Moves focus to the next or previous row button of the same list; false at either end. */
export function moveRowFocus(from: HTMLElement, delta: 1 | -1): boolean {
  const list = from.closest('ul');
  if (list === null) return false;
  const rows = [...list.querySelectorAll<HTMLElement>(`[${ROW_ATTRIBUTE}]`)];
  const next = rows[rows.indexOf(from) + delta];
  if (next === undefined) return false;
  next.focus();
  return true;
}

export interface RowAction {
  readonly label: string;
  readonly onSelect: () => void;
}

/** What the builder can do to a row: change it, or ask where it came from. */
export interface RowHandlers {
  readonly onChange: (row: ShapeProposalDto, change: RowChange) => void;
  /** Scrolls the conversation to the messages the row came from and highlights them. */
  readonly onWhy: (row: ShapeProposalDto) => void;
}

export interface ProposalRowProps {
  readonly row: ShapeProposalDto;
  /** The kind's label, on the first row of its section only. */
  readonly label: string | null;
  /** A dimmed line under the row, for the first row of a section that needs one. */
  readonly note: string | undefined;
  /** The section the row opens, so a summary count can jump to the first row of it. */
  readonly section: string;
  /** The one row the Tab key reaches; the arrows move between the rest. */
  readonly tabbable: boolean;
  /** The row's tasks' derived sizes: one for a loose task, one per sized task of a goal. */
  readonly sizes: readonly ShapeTaskSizeDto[];
  /** Extra menu items, such as the undos of a converted row. */
  readonly actions: readonly RowAction[];
  readonly handlers: RowHandlers;
}

/** "Sized M (~2 h) · took 5 h of lane time" under a task row, or a goal's summed hours (§8). */
function SizeLines({
  row,
  sizes,
}: {
  readonly row: ShapeProposalDto;
  readonly sizes: readonly ShapeTaskSizeDto[];
}) {
  if (row.kind === 'goal') {
    const total = goalHoursLine(sizes);
    const off = sizes.filter((s) => s.missized).length;
    return total === null ? null : (
      <Text size="xs" c="dimmed">
        {total}
        {off > 0 ? ` · ${String(off)} mis-sized` : ''}
      </Text>
    );
  }
  return (
    <>
      {sizes.map((s) => {
        const line = sizeLine(s);
        return (
          <Text key={s.key} size="xs" c="dimmed">
            {line.text}
            {line.flagged ? (
              <>
                {' '}
                <IconClockExclamation
                  size={14}
                  stroke={1.5}
                  role="img"
                  aria-label="Outside its size by more than one bucket"
                  style={{ verticalAlign: '-2px' }}
                />
              </>
            ) : null}
          </Text>
        );
      })}
    </>
  );
}

/**
 * One row of the Proposed list: a button over a region, as Factory's goal rows are, so Enter opens
 * the details. A pending row edits in place (a pencil, or E); an edit pins it. P pins or unpins the
 * row and W asks why. Its menu is a sibling of the button, because a button can't hold another control.
 */
export function ProposalRow({
  row,
  label,
  note,
  section,
  tabbable,
  sizes,
  actions,
  handlers,
}: ProposalRowProps) {
  const [opened, setOpened] = useState(false);
  const [editing, setEditing] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const title = proposalTitle(row);
  const converted = convertedLine(row);
  const meta = rowMeta(row);
  const mark = markText(row);
  const regionId = `shape-row-${row.id}`;
  const pinned = row.pinned.length > 0;
  const mutable =
    row.state === ShapeProposalState.Pending || row.state === ShapeProposalState.Superseded;
  const canEdit = mutable && editableFields(row).length > 0;
  const earlier = row.state === ShapeProposalState.Superseded;

  const change = (c: RowChange): void => {
    handlers.onChange(row, c);
  };
  const togglePin = (): void => {
    change(pinned ? { kind: 'unpin' } : { kind: 'restore' });
  };
  const startEditing = (): void => {
    setOpened(true);
    setEditing(true);
  };
  const stopEditing = (): void => {
    setEditing(false);
    button.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const delta = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : null;
    if (delta !== null) {
      if (moveRowFocus(event.currentTarget, delta)) event.preventDefault();
      return;
    }
    const key = event.key.toLowerCase();
    if (key === 'w') handlers.onWhy(row);
    else if (key === 'p' && mutable) togglePin();
    else if (key === 'e' && canEdit) startEditing();
    else return;
    event.preventDefault();
  };

  const menu: RowAction[] = [
    ...(canEdit ? [{ label: 'Edit', onSelect: startEditing }] : []),
    ...(earlier
      ? [
          {
            label: 'Restore',
            onSelect: () => {
              change({ kind: 'restore' });
            },
          },
        ]
      : []),
    ...(mutable && !earlier ? [{ label: pinned ? 'Unpin' : 'Pin', onSelect: togglePin }] : []),
    {
      label: 'Why?',
      onSelect: () => {
        handlers.onWhy(row);
      },
    },
    ...(mutable
      ? [
          {
            label: 'Drop',
            onSelect: () => {
              change({ kind: 'drop' });
            },
          },
        ]
      : []),
    ...actions,
  ];

  return (
    <li style={{ listStyle: 'none', borderTop: '1px solid var(--mantine-color-default-border)' }}>
      <Group
        wrap="nowrap"
        align="flex-start"
        gap="sm"
        py={8}
        // Rows far below the fold cost nothing until they scroll near.
        style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 44px' }}
      >
        <Text
          size="xs"
          c="dimmed"
          w={64}
          style={{ flex: 'none', textTransform: 'uppercase' }}
          aria-hidden="true"
        >
          {label}
        </Text>
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Group wrap="nowrap" align="flex-start" gap="xs">
            <UnstyledButton
              ref={button}
              {...{ [ROW_ATTRIBUTE]: '' }}
              data-section={section}
              aria-expanded={opened}
              aria-controls={opened ? regionId : undefined}
              tabIndex={tabbable ? 0 : -1}
              onClick={() => {
                setOpened((o) => !o);
                setEditing(false);
              }}
              onKeyDown={onKeyDown}
              style={{ flex: 1, minWidth: 0, textAlign: 'left' }}
            >
              <Text
                size="sm"
                c={converted === null ? 'bright' : 'dimmed'}
                fw={500}
                {...(opened ? {} : { lineClamp: 2 })}
              >
                {title}
                {pinned ? (
                  <>
                    {' '}
                    <IconPin
                      size={16}
                      stroke={1.5}
                      role="img"
                      aria-label="Pinned"
                      color="var(--mantine-color-dimmed)"
                      style={{ verticalAlign: '-3px' }}
                    />
                  </>
                ) : null}
              </Text>
              {meta === '' ? null : (
                <Text size="xs" c="dimmed">
                  {meta}
                </Text>
              )}
              <SizeLines row={row} sizes={sizes} />
              {converted === null ? null : (
                <Text size="xs" c="dimmed">
                  {converted}
                </Text>
              )}
            </UnstyledButton>
            {mark === null ? null : (
              <Text size="xs" c="dimmed" style={{ flex: 'none' }} data-mark={row.mark}>
                {mark}
              </Text>
            )}
            {canEdit ? (
              <ActionIcon
                variant="subtle"
                size="sm"
                aria-label={`Edit ${title}`}
                onClick={startEditing}
              >
                <IconPencil size={16} stroke={1.5} />
              </ActionIcon>
            ) : null}
            <Menu position="bottom-end" withinPortal>
              <Menu.Target>
                <ActionIcon variant="subtle" size="sm" aria-label={`Actions for ${title}`}>
                  <IconDots size={16} stroke={1.5} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                {menu.map((action) => (
                  <Menu.Item key={action.label} onClick={action.onSelect}>
                    {action.label}
                  </Menu.Item>
                ))}
              </Menu.Dropdown>
            </Menu>
          </Group>
          {opened ? (
            <Box id={regionId} role="region" aria-label={`${title} details`} pt="xs" pb={4}>
              {editing ? (
                <RowEditor
                  row={row}
                  onCancel={stopEditing}
                  onSave={(fields) => {
                    change({ kind: 'edit', fields });
                    stopEditing();
                  }}
                />
              ) : (
                <>
                  <RowDetails row={row} />
                  <Group gap="xs" pt="xs">
                    <Button
                      variant="subtle"
                      size="compact-xs"
                      onClick={() => {
                        handlers.onWhy(row);
                      }}
                    >
                      Why?
                    </Button>
                    {earlier ? (
                      <Button
                        variant="subtle"
                        size="compact-xs"
                        onClick={() => {
                          change({ kind: 'restore' });
                        }}
                      >
                        Restore
                      </Button>
                    ) : null}
                  </Group>
                </>
              )}
            </Box>
          ) : null}
        </Box>
      </Group>
      {note === undefined ? null : (
        <Text size="xs" c="dimmed" pl={76} pb={6}>
          {note}
        </Text>
      )}
    </li>
  );
}
