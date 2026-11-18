import { PassState, type TaskId } from '@10db/contracts';
import { Box, Button, Flex, Text } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { markPassNotificationsActed, shownPassNotifications } from '../../desktop/notify-pass';
import { useFrameSlots } from '../../shell/frame-slots';
import { Panel } from '../../shell/panel';
import { useNow } from '../../shell/relative';
import { TitleRow } from '../../shell/title-row';
import { Announcer } from './announcer';
import { hasContent } from '../../conversation/drafts';
import { draftKey, sessionDrafts, useSessionDraft } from '../sessions/session-drafts';
import { focusTarget } from './focus-target';
import { CodeSpans } from '../../shell/code-spans';
import { PagePane } from './page-pane';
import { countsLine, PassMenu } from './pass-header';
import { PageStatus } from './page-status';
import { PrButton, PrReason } from './pr-button';
import { RowMenu } from './row-menu';
import type { PassWorkspaceProps } from './pass-workspace-props';
import { QUEUE_ATTRIBUTE, QueueList } from './queue-list';
import { queueRows, shownRow } from './queue-rows';
import { TakeOutModal } from './take-out-modal';
import { useWorkbenchKeys } from './use-workbench-keys';
import { nextWaiting, stepIndex, WorkbenchKey } from './workbench-keys';

/** A working line's minutes move once a minute; half that keeps them on time. */
const CLOCK_TICK_MS = 30_000;

/**
 * The open pass's queue and the shown page's thread (Workbench spec §4.3). While the frame draws the
 * panel the queue is the panel's body, under the pass's name and menu, and the title row names the
 * shown page; otherwise (the panel folded, closed or absent) the queue is a strip of rows across the top
 * of the content and the pass's own line is the title row's. The queue is drawn once either way. With no
 * page selected the thread shows the queue's first page. Each page keeps its own draft, after the
 * Workbench is left too.
 */
export function PassWorkspace(props: PassWorkspaceProps) {
  const { view, inbox, project, selected, onAddPage, passActions } = props;
  const { panelShown, closeSheet } = useFrameSlots();
  const now = useNow(CLOCK_TICK_MS);
  const rows = queueRows(view, inbox, now);
  const shown = shownRow(rows, selected);
  // A row picked in a sheet closes it, as the page it shows does not change the path the frame watches.
  const onSelect = (taskId: TaskId): void => {
    closeSheet();
    props.onSelect(taskId);
  };
  // Each page's unsent draft is kept by its task, as Sessions keeps a task tab's, so another page, another
  // view or a restart (its words) finds it where it was left.
  const [draft, setDraft] = useSessionDraft(draftKey.task(shown?.page.taskId ?? ''));
  // The page whose Take Out confirm is open.
  const [takingOut, setTakingOut] = useState<TaskId | null>(null);
  const takingOutPage = view.pages.find((page) => page.taskId === takingOut) ?? null;

  // As the window gains focus, the page a ready notification just named, or the one that has waited
  // longest when the shown page waits on nothing; never away from a draft. The composer of the page
  // then shown takes the cursor either way (spec §4.3), unless a dialog is open over the view.
  const onFocus = useRef<() => void>(() => undefined);
  const [composerFocus, setComposerFocus] = useState(0);
  useEffect(() => {
    onFocus.current = () => {
      const target = focusTarget({
        now: Date.now(),
        notified: shownPassNotifications(),
        rows: rows.map((row) => ({ taskId: row.page.taskId, status: row.status })),
        selected: shown?.page.taskId ?? null,
        drafts: new Set(
          rows
            .map((row) => row.page.taskId)
            .filter((taskId) => hasContent(sessionDrafts.get(draftKey.task(taskId)))),
        ),
      });
      if (target !== null) {
        markPassNotificationsActed(target);
        if (target !== shown?.page.taskId) props.onSelect(target);
      }
      if (document.querySelector('[role="dialog"]') === null)
        setComposerFocus((asked) => asked + 1);
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
  // The queue is a new list when it moves between the panel and the strip, which drops the focus it held:
  // where the focus last went says whether it was in the queue, and it goes back to the shown page's row.
  const focusInQueue = useRef(false);
  useEffect(() => {
    const track = (event: FocusEvent): void => {
      focusInQueue.current =
        event.target instanceof Node && queue.current?.contains(event.target) === true;
    };
    document.addEventListener('focusin', track);
    return () => {
      document.removeEventListener('focusin', track);
    };
  }, []);
  const placed = useRef(panelShown);
  useLayoutEffect(() => {
    if (placed.current === panelShown) return;
    placed.current = panelShown;
    if (focusInQueue.current)
      queue.current?.querySelector<HTMLButtonElement>('button[aria-current]')?.focus();
  }, [panelShown]);
  const move = (delta: 1 | -1): void => {
    // The rows' own buttons, not their menus.
    const buttons = [
      ...(queue.current?.querySelectorAll<HTMLButtonElement>(
        `[${QUEUE_ATTRIBUTE}] button:not([aria-haspopup])`,
      ) ?? []),
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
    // Escape in a field goes back to the shown page's row, where J and K go on.
    [WorkbenchKey.LeaveField]: () => {
      const current = queue.current?.querySelector<HTMLButtonElement>('button[aria-current]');
      const first = queue.current?.querySelector<HTMLButtonElement>(
        `[${QUEUE_ATTRIBUTE}] button:not([aria-haspopup])`,
      );
      (current ?? first)?.focus();
    },
    [WorkbenchKey.NextWaiting]: () => {
      const next = nextWaiting(
        rows.map((row) => ({ taskId: row.page.taskId, status: row.status })),
        shown?.page.taskId ?? null,
      );
      if (next !== null) props.onSelect(next);
    },
  });

  const queueList = (
    <>
      <QueueList
        rows={rows}
        current={shown?.page.taskId ?? null}
        onSelect={onSelect}
        onTakeOut={view.pass.state === PassState.Open ? setTakingOut : null}
      />
      {/* A page is added where the pages are: an outline at the list's foot, quieter than a row. */}
      <Box p="xs">
        <Button
          variant="default"
          size="xs"
          fullWidth
          justify="flex-start"
          leftSection={<IconPlus size={14} stroke={1.5} />}
          disabled={view.pass.state !== PassState.Open}
          onClick={onAddPage}
          style={{ borderStyle: 'dashed', background: 'transparent', fontWeight: 400 }}
        >
          Add Page
        </Button>
      </Box>
    </>
  );
  const counts = countsLine(rows.map((row) => row.status));
  const signedOff = rows.some((row) => row.status === PageStatus.SignedOff);

  return (
    <Flex direction="column" style={{ flex: 1, minHeight: 0 }}>
      {/* Always mounted, so the frame knows the section has a panel; it holds the queue only while drawn. */}
      <Panel
        section="workbench"
        title={view.pass.name}
        controls={
          panelShown && view.pages.length > 0 && passActions !== undefined ? (
            <PassMenu state={view.pass.state} {...passActions} />
          ) : undefined
        }
      >
        {panelShown ? (
          <div ref={queue}>
            {counts === '' ? null : (
              <Text size="xs" c="dimmed" px="sm" pb={6}>
                {counts}
              </Text>
            )}
            {signedOff ? (
              <Box px="sm" pb="xs">
                <PrButton view={view} />
                <PrReason view={view} />
              </Box>
            ) : null}
            {queueList}
          </div>
        ) : null}
      </Panel>
      {panelShown && shown !== null ? (
        <TitleRow
          title={shown.page.label}
          meta={
            <CodeSpans
              text={
                shown.page.route === null
                  ? shown.state.line
                  : `${shown.state.line} · ${shown.page.route}`
              }
            />
          }
          actions={
            view.pass.state === PassState.Open ? (
              <RowMenu
                label={shown.page.label}
                onTakeOut={() => {
                  setTakingOut(shown.page.taskId);
                }}
              />
            ) : undefined
          }
        />
      ) : null}
      {panelShown ? null : (
        <Box ref={queue} style={{ flex: 'none', overflowY: 'auto' }}>
          {queueList}
        </Box>
      )}
      <Announcer rows={rows} />
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
          composerFocus={composerFocus}
          draft={draft}
          onDraft={setDraft}
          pullRequest={<PrButton view={view} />}
        />
      )}
      {takingOutPage === null ? null : (
        <TakeOutModal
          passId={view.pass.id}
          taskId={takingOutPage.taskId}
          label={takingOutPage.label}
          onClose={() => {
            setTakingOut(null);
          }}
        />
      )}
    </Flex>
  );
}
