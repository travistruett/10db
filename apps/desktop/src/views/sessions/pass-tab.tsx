import {
  PassNoticeKind,
  PassSignOff,
  PassState,
  type PassViewDto,
  type ProjectViewDto,
  type TaskSessionDto,
} from '@10db/contracts';
import { ActionIcon, Anchor, Box, Button, Menu, Stack, Text } from '@mantine/core';
import { IconDots } from '@tabler/icons-react';
import { useState } from 'react';
import { EMPTY_DRAFT, type Draft } from '../../conversation/drafts';
import { useAbandonPass, usePassView } from '../../daemon/pass-queries';
import { useInbox } from '../../daemon/queries';
import { PageLoading, PageLoadingShape } from '../../shell/page-loading';
import { useNow } from '../../shell/relative';
import { AbandonModal } from '../workbench/abandon-modal';
import { CloseProgress } from '../workbench/close-progress';
import { ClosePassModal } from '../workbench/close-pass-modal';
import { ClosedPassLine } from '../workbench/closed-pass-line';
import { MenuAction } from '../workbench/menu-action';
import { PagePane } from '../workbench/page-pane';
import { PageStatus } from '../workbench/page-status';
import { PrButton } from '../workbench/pr-button';
import { queueRows } from '../workbench/queue-rows';
import { useOpenSession } from './open-session';
import { TASK_BAR_BUTTON, TaskBar } from './task-bar';

// Sessions UI §8.5: a task in Your folder is a pass of one. Its tab is the Workbench's page: the same thread,
// composer, Sign Off and close, under the task's bar.

/** The clock behind the working line's minutes. */
const CLOCK_TICK_MS = 30_000;

export interface PassTabProps {
  readonly session: TaskSessionDto;
  readonly project: ProjectViewDto | undefined;
}

export function PassTab({ session, project }: PassTabProps) {
  const read = usePassView(session.passId);
  const view = read.data;
  if (view === undefined || project === undefined)
    return (
      <Box style={{ flex: 1 }}>
        <TaskBar title={session.title} taskId={session.taskId} kindLine="Task · Your folder" />
        <Box px="md" pt="md">
          <PageLoading shape={PageLoadingShape.Lines} label="Loading the task" />
        </Box>
      </Box>
    );
  if (view === null)
    return (
      <Box style={{ flex: 1 }}>
        <TaskBar title={session.title} taskId={session.taskId} kindLine="Task · Your folder" />
        <Text px="md" pt="md" size="sm" role="status">
          Done · this task’s pass has finished.
        </Text>
      </Box>
    );
  return <PassTabBody session={session} project={project} view={view} />;
}

interface BodyProps {
  readonly session: TaskSessionDto;
  readonly project: ProjectViewDto;
  readonly view: PassViewDto;
}

function PassTabBody({ session, project, view }: BodyProps) {
  const now = useNow(CLOCK_TICK_MS);
  const inbox = useInbox().data ?? [];
  const openSession = useOpenSession();
  const abandon = useAbandonPass();
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [dialog, setDialog] = useState<'close' | 'abandon' | null>(null);
  const row = queueRows(view, inbox, now)[0];
  const open = view.pass.state === PassState.Open;
  const abandonable =
    open || view.pass.state === PassState.Closing || view.pass.state === PassState.Abandoning;
  const signedOff = view.pages.some((page) => page.signOff === PassSignOff.Done);
  const closed = view.pass.state === PassState.Closed;
  const from = session.fromChat;
  const closeDialog = () => {
    setDialog(null);
  };
  const bar = (
    <TaskBar
      title={session.title}
      taskId={session.taskId}
      kindLine={`Task · Your folder · lands on \`${view.pass.returnBranch}\``}
      actions={
        <>
          {signedOff ? (
            <Button
              {...TASK_BAR_BUTTON}
              // Nothing lands until the close runs, so with nothing working it is the bar's primary.
              variant={row?.status === PageStatus.SignedOff ? 'filled' : 'default'}
              disabled={!open}
              onClick={() => {
                setDialog('close');
              }}
            >
              Close Pass…
            </Button>
          ) : null}
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <ActionIcon variant="subtle" color="gray" aria-label="More actions">
                <IconDots size={16} stroke={1.5} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <MenuAction
                label="Abandon Pass…"
                byline="Stop here. Unfinished changes leave your folder and wait on their Board task."
                color="red"
                disabled={!abandonable}
                onClick={() => {
                  setDialog('abandon');
                }}
              />
            </Menu.Dropdown>
          </Menu>
        </>
      }
    />
  );
  return (
    <Stack gap={0} style={{ flex: 1, minHeight: 0 }}>
      {bar}
      {from === null ? null : (
        <Anchor
          component="button"
          type="button"
          size="xs"
          c="dimmed"
          px="md"
          style={{ alignSelf: 'flex-start' }}
          onClick={() => {
            void openSession(from.chatId, project.id);
          }}
        >
          From chat: {from.title}
        </Anchor>
      )}
      {closed ? (
        <Box px="md" py="xs">
          <ClosedPassLine view={view} inbox={inbox} />
        </Box>
      ) : null}
      <Box px="md">
        <CloseProgress
          state={view.pass.state}
          step={view.closeStep}
          facts={{
            delivery: project.delivery,
            gated: project.gateCommand !== null,
            takingOut: view.pages.some((page) => page.signOff !== PassSignOff.Done),
            stopped: view.notices.some((notice) => notice.kind === PassNoticeKind.Close),
          }}
        />
      </Box>
      {row === undefined ? null : (
        <PagePane
          passId={view.pass.id}
          appUrl={project.appUrl}
          row={row}
          passOpen={open}
          openedAt={
            view.turns.find(
              (turn) => turn.taskId === row.page.taskId && turn.seq === row.page.turn?.seq,
            )?.openedAt ?? null
          }
          composerFocus={0}
          draft={draft}
          onDraft={setDraft}
          pullRequest={<PrButton view={view} />}
          header={<Box />}
        />
      )}
      {dialog === 'close' ? <ClosePassModal view={view} onClose={closeDialog} /> : null}
      {dialog === 'abandon' ? (
        <AbandonModal
          view={view}
          inbox={inbox}
          now={now}
          onClose={closeDialog}
          abandon={() => abandon.mutateAsync(view.pass.id)}
        />
      ) : null}
    </Stack>
  );
}
