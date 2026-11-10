import { PassState, type TaskId } from '@10db/contracts';
import { Box, Flex } from '@mantine/core';
import { useViewportSize } from '@mantine/hooks';
import { useEffect, useRef, useState } from 'react';
import { useTakeOutPage } from '../../daemon/pass-queries';
import { markPassNotificationsActed, shownPassNotifications } from '../../desktop/notify-pass';
import { useNow } from '../../shell/relative';
import { Announcer } from './announcer';
import { EMPTY_DRAFT, hasContent, type Draft } from './drafts';
import { focusTarget } from './focus-target';
import { PagePane } from './page-pane';
import type { PassWorkspaceProps } from './pass-workspace-props';
import { QueueList } from './queue-list';
import { queueRows, shownRow } from './queue-rows';
import { TakeOutModal } from './take-out-modal';
import { useWorkbenchKeys } from './use-workbench-keys';
import { nextWaiting, stepIndex, WorkbenchKey } from './workbench-keys';
import { WorkbenchLayout, workbenchLayout } from './workbench-layout';

/** The queue's width beside the thread in the wide layout. */
const QUEUE_WIDTH_PX = 280;

/** A working line's minutes move once a minute; half that keeps them on time. */
const CLOCK_TICK_MS = 30_000;

/**
 * The open pass's queue and the shown page's thread (Workbench spec §4.3). Narrow: the queue is a strip
 * of rows across the top and the thread fills the rest. Wide: the queue on the left, the thread beside
 * it. With no page selected the thread shows the queue's first page. Each page keeps its own draft.
 */
export function PassWorkspace({ view, inbox, project, selected, onSelect }: PassWorkspaceProps) {
  const now = useNow(CLOCK_TICK_MS);
  const layout = workbenchLayout(useViewportSize().width);
  const rows = queueRows(view, inbox, now);
  const shown = shownRow(rows, selected);
  const wide = layout === WorkbenchLayout.Wide;
  // Each page's unsent draft, kept while another page is shown.
  const [drafts, setDrafts] = useState<ReadonlyMap<TaskId, Draft>>(new Map());
  // The page whose Take Out… confirm is open.
  const [takingOut, setTakingOut] = useState<TaskId | null>(null);
  const takeOut = useTakeOutPage();
  const takingOutPage = view.pages.find((page) => page.taskId === takingOut) ?? null;

  // As the window gains focus, the page a ready notification just named, or the one that has waited
  // longest when the shown page waits on nothing; never away from a draft.
  const onFocus = useRef<() => void>(() => undefined);
  useEffect(() => {
    onFocus.current = () => {
      const target = focusTarget({
        now: Date.now(),
        notified: shownPassNotifications(),
        rows: rows.map((row) => ({ taskId: row.page.taskId, status: row.status })),
        selected: shown?.page.taskId ?? null,
        drafts: new Set(
          [...drafts].filter(([, draft]) => hasContent(draft)).map(([taskId]) => taskId),
        ),
      });
      if (target === null) return;
      markPassNotificationsActed(target);
      if (target !== shown?.page.taskId) onSelect(target);
    };
  });
  useEffect(() => {
    const focused = () => {
      onFocus.current();
    };
    window.addEventListener('focus', focused);
    return () => {
      window.removeEventListener('focus', focused);
    };
  }, []);

  // J and K move the focus along the queue's rows, and Enter on a row selects it.
  const queue = useRef<HTMLDivElement>(null);
  const move = (delta: 1 | -1): void => {
    // The rows' own buttons, not their menus.
    const buttons = [
      ...(queue.current?.querySelectorAll<HTMLButtonElement>('button:not([aria-haspopup])') ?? []),
    ];
    const focused = buttons.findIndex((button) => button === document.activeElement);
    const from = focused >= 0 ? focused : rows.findIndex((row) => row === shown);
    const to = stepIndex(from >= 0 ? from : null, delta, buttons.length);
    if (to !== null) buttons[to]?.focus();
  };
  useWorkbenchKeys({
    [WorkbenchKey.Next]: () => {
      move(1);
    },
    [WorkbenchKey.Previous]: () => {
      move(-1);
    },
    [WorkbenchKey.NextWaiting]: () => {
      const next = nextWaiting(
        rows.map((row) => ({ taskId: row.page.taskId, status: row.status })),
        shown?.page.taskId ?? null,
      );
      if (next !== null) onSelect(next);
    },
  });

  return (
    <Flex direction={wide ? 'row' : 'column'} style={{ flex: 1, minHeight: 0 }}>
      <Box
        ref={queue}
        style={{
          flex: 'none',
          width: wide ? QUEUE_WIDTH_PX : undefined,
          borderRight: wide ? '1px solid var(--mantine-color-default-border)' : undefined,
          overflowY: 'auto',
        }}
      >
        <QueueList
          rows={rows}
          current={shown?.page.taskId ?? null}
          onSelect={onSelect}
          onTakeOut={view.pass.state === PassState.Open ? setTakingOut : null}
        />
        <Announcer rows={rows} />
      </Box>
      {shown === null ? null : (
        <PagePane
          passId={view.pass.id}
          appUrl={project.appUrl}
          row={shown}
          passOpen={view.pass.state === PassState.Open}
          openedAt={
            view.turns.find(
              (turn) => turn.taskId === shown.page.taskId && turn.seq === shown.page.turn?.seq,
            )?.openedAt ?? null
          }
          now={now}
          draft={drafts.get(shown.page.taskId) ?? EMPTY_DRAFT}
          onDraft={(draft) => {
            const taskId = shown.page.taskId;
            setDrafts((held) => new Map(held).set(taskId, draft));
          }}
        />
      )}
      {takingOutPage === null ? null : (
        <TakeOutModal
          area={takingOutPage.area}
          onClose={() => {
            setTakingOut(null);
          }}
          takeOut={() =>
            takeOut.mutateAsync({ passId: view.pass.id, taskId: takingOutPage.taskId })
          }
        />
      )}
    </Flex>
  );
}
