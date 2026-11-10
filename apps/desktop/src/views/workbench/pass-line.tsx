import type { InboxItemDto, PassViewDto } from '@10db/contracts';
import { Anchor } from '@mantine/core';
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

/** Factory's line for a project with a live pass (Workbench spec §4.1), which opens the Workbench. */
export function PassLine({ view, inbox, now, onOpen }: PassLineProps) {
  const clock = { now, medianTurnMinutes: medianTurnMinutes(view.turns) };
  const entries = view.pages.map((page) => ({
    status: pageStatus(page, inbox, clock).status,
    readyAt: page.turn?.readyAt ?? null,
  }));
  return (
    <Anchor component="button" type="button" size="sm" onClick={onOpen}>
      {passLineText(view.pass.name, waitingCount(entries))}
    </Anchor>
  );
}
