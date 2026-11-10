import type { InboxItemDto, PassPageDto, PassViewDto, TaskId } from '@10db/contracts';
import { askOf, pageStatus, type PageState } from './page-status';
import { isDimmed, queueOrder } from './queue-order';
import { medianTurnMinutes } from './timing';

/** One page as the queue draws it. */
export interface QueueRow {
  readonly page: PassPageDto;
  readonly state: PageState;
  readonly status: PageState['status'];
  /** When the page's turn was Ready, for the queue's order. */
  readonly readyAt: string | null;
  /** Nothing on the row waits on the builder: its text is dimmed. */
  readonly dimmed: boolean;
  /** The open question or permission from the page's run, which the page answers in place. */
  readonly ask: InboxItemDto | null;
}

/** The pass's pages in queue order at `now`, each with its state from the page and the open Inbox. */
export function queueRows(
  view: PassViewDto,
  inbox: readonly InboxItemDto[],
  now: number,
): QueueRow[] {
  const clock = { now, medianTurnMinutes: medianTurnMinutes(view.turns) };
  return queueOrder(
    view.pages.map((page) => {
      const state = pageStatus(page, inbox, clock, view);
      return {
        page,
        state,
        status: state.status,
        readyAt: page.turn?.readyAt ?? null,
        dimmed: isDimmed(state.status),
        ask: askOf(page, inbox) ?? null,
      };
    }),
  );
}

/** The row the thread shows: the selected page's, else the queue's first when none of its pages is. */
export function shownRow(rows: readonly QueueRow[], selected: TaskId | null): QueueRow | null {
  return rows.find((row) => row.page.taskId === selected) ?? rows[0] ?? null;
}
