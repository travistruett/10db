import type { InboxItemDto, PassViewDto } from '@10db/contracts';
import { Group, Text, UnstyledButton } from '@mantine/core';
import { IconTools } from '@tabler/icons-react';
import { StatusDot } from '../factory/status-dot';
import { pageStatus } from './page-status';
import { waitingCount } from './queue-order';
import { medianTurnMinutes } from './timing';

export interface PassLineProps {
  readonly view: PassViewDto;
  /** The open Inbox items: a page's question or permission targets its run. */
  readonly inbox: readonly InboxItemDto[];
  /** Now, in epoch milliseconds. */
  readonly now: number;
  /** Opens the pass's project in the Workbench. */
  readonly onOpen: () => void;
}

/** "Settings pass · 3 waiting": the name and the pages waiting on the builder; none is not said. */
export function passLineText(name: string, waiting: number): string {
  return waiting === 0 ? name : `${name} · ${String(waiting)} waiting`;
}

/**
 * Factory's row for a project with a live pass (Workbench spec §4.1), shaped as a goal row: the UI
 * Workbench's mark, a dot that is yellow while pages wait on the builder, the pass's name and what
 * waits. It opens the Workbench.
 */
export function PassLine({ view, inbox, now, onOpen }: PassLineProps) {
  const clock = { now, medianTurnMinutes: medianTurnMinutes(view.turns) };
  const entries = view.pages.map((page) => ({
    status: pageStatus(page, inbox, clock, view).status,
    readyAt: page.turn?.readyAt ?? null,
  }));
  const waiting = waitingCount(entries);
  return (
    <UnstyledButton
      w="100%"
      px="sm"
      py="xs"
      onClick={onOpen}
      aria-label={passLineText(view.pass.name, waiting)}
      style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}
    >
      <Group gap="sm" wrap="nowrap" align="baseline">
        <IconTools
          size={16}
          stroke={1.5}
          aria-hidden
          style={{ alignSelf: 'center', flex: 'none' }}
        />
        <StatusDot color={waiting > 0 ? 'yellow' : 'blue'} />
        <Text fw={600} size="sm" style={{ flex: 'none' }}>
          {view.pass.name}
        </Text>
        <Text size="sm" c="dimmed" style={{ minWidth: 0 }}>
          {waiting > 0 ? `UI Workbench · ${String(waiting)} waiting on you` : 'UI Workbench'}
        </Text>
      </Group>
    </UnstyledButton>
  );
}
