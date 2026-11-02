import type { ShapeProposalDto } from '@10db/contracts';
import { ActionIcon, Box, Group, Menu, Text, UnstyledButton } from '@mantine/core';
import { IconDots } from '@tabler/icons-react';
import { useState, type KeyboardEvent } from 'react';
import { convertedLine, proposalTitle, rowMeta } from './proposal-text';
import { RowDetails } from './row-details';

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
  readonly actions: readonly RowAction[];
}

/**
 * One row of the Proposed list: a button over a region, as Factory's goal rows are, so Enter opens
 * the details. It is read-only in this slice; the arrows move between rows. Its menu is a sibling of
 * the button, because a button can't hold another control.
 */
export function ProposalRow({ row, label, note, section, tabbable, actions }: ProposalRowProps) {
  const [opened, setOpened] = useState(false);
  const title = proposalTitle(row);
  const converted = convertedLine(row);
  const meta = rowMeta(row);
  const regionId = `shape-row-${row.id}`;

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const delta = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : null;
    if (delta === null) return;
    if (moveRowFocus(event.currentTarget, delta)) event.preventDefault();
  };

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
              {...{ [ROW_ATTRIBUTE]: '' }}
              data-section={section}
              aria-expanded={opened}
              aria-controls={opened ? regionId : undefined}
              tabIndex={tabbable ? 0 : -1}
              onClick={() => {
                setOpened((o) => !o);
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
              </Text>
              {meta === '' ? null : (
                <Text size="xs" c="dimmed">
                  {meta}
                </Text>
              )}
              {converted === null ? null : (
                <Text size="xs" c="dimmed">
                  {converted}
                </Text>
              )}
            </UnstyledButton>
            {actions.length === 0 ? null : (
              <Menu position="bottom-end" withinPortal>
                <Menu.Target>
                  <ActionIcon variant="subtle" size="sm" aria-label={`Actions for ${title}`}>
                    <IconDots size={16} stroke={1.5} />
                  </ActionIcon>
                </Menu.Target>
                <Menu.Dropdown>
                  {actions.map((action) => (
                    <Menu.Item key={action.label} onClick={action.onSelect}>
                      {action.label}
                    </Menu.Item>
                  ))}
                </Menu.Dropdown>
              </Menu>
            )}
          </Group>
          {opened ? (
            <Box id={regionId} role="region" aria-label={`${title} details`} pt="xs" pb={4}>
              <RowDetails row={row} />
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
