import { ChangesScope, type ProjectViewDto, type TaskSessionDto } from '@10db/contracts';
import { Box, Button, Flex, Text } from '@mantine/core';
import { useElementSize } from '@mantine/hooks';
import { useState } from 'react';
import { useWorkstreamChanges, useWorkstreams } from '../../daemon/queries';
import { useTaskSession } from '../../daemon/task-session-queries';
import { PageLoading, PageLoadingShape } from '../../shell/page-loading';
import { changesChoice } from './changes-choice';
import { changesTotals } from './changes-files';
import { ChangesPanel } from './changes-panel';
import { CopyTab } from './copy-tab';
import { PassTab } from './pass-tab';
import type { Quote } from './quote';
import { TASK_BAR_BUTTON } from './task-bar';
import type { TaskTab as TaskTabEntry } from './task-tabs';
import { useSessionKeys } from './use-session-keys';

/** The width at which Changes opens beside the thread by itself. */
const AUTO_OPEN_PX = 1100;

export interface TaskTabProps {
  readonly tab: TaskTabEntry;
  readonly project: ProjectViewDto | undefined;
}

/**
 * A task's tab (sessions UI §8.4): a separate copy shows its thread and where its run stands; a pass of one
 * shows its one page, with Sign Off and Close Pass…. Changes sits beside either.
 */
export function TaskTab({ tab, project }: TaskTabProps) {
  const session = useTaskSession(tab.taskId);
  if (session.data === undefined)
    return (
      <Box px="md" pt="md" role="status" aria-label="Task">
        {session.isError ? (
          <Text size="sm" c="dimmed">
            This task can’t be read: {session.error.message}
          </Text>
        ) : (
          <PageLoading shape={PageLoadingShape.Lines} label="Loading the task" />
        )}
      </Box>
    );
  return <LoadedTaskTab session={session.data} project={project} />;
}

function LoadedTaskTab({
  session,
  project,
}: {
  readonly session: TaskSessionDto;
  readonly project: ProjectViewDto | undefined;
}) {
  const workstreams = useWorkstreams({ active: false });
  const workstreamId = session.workstreamId ?? undefined;
  // The diff is keyed by the run's last change, so a turn that ends shows its changes.
  const stamp = workstreams.data?.find((w) => w.id === workstreamId)?.updatedAt ?? null;
  const [scope, setScope] = useState<ChangesScope>(ChangesScope.All);
  const changes = useWorkstreamChanges(workstreamId, stamp, scope, true);
  // The tab's own width, not the window's: the rail and panel take some of the window.
  const { ref: sizeRef, width } = useElementSize();
  const wide = width >= AUTO_OPEN_PX;
  // Until the builder chooses, it opens by itself once there are changes and room; after that their
  // choice holds for the tab.
  const [choice, setChoiceState] = useState<boolean | null>(() =>
    changesChoice.get(session.taskId),
  );
  const setChoice = (open: boolean): void => {
    changesChoice.set(session.taskId, open);
    setChoiceState(open);
  };
  const totals = changes.data === undefined ? null : changesTotals(changes.data.files);
  const hasChanges = totals !== null && totals.files > 0;
  // Once it has opened by itself, a read under way (another scope, a newer stamp) doesn't close it.
  const [autoOpened, setAutoOpened] = useState(false);
  if (choice === null && wide && hasChanges && !autoOpened) setAutoOpened(true);
  const open = workstreamId !== undefined && (choice ?? (wide && (hasChanges || autoOpened)));
  const [quote, setQuote] = useState<Quote | null>(null);
  const toggle = (): void => {
    setChoice(!open);
  };
  useSessionKeys((key) => {
    if (key.kind !== 'changes' || workstreamId === undefined) return false;
    toggle();
    return true;
  });
  const control =
    workstreamId === undefined ? null : (
      <Button {...TASK_BAR_BUTTON} aria-pressed={open} onClick={toggle}>
        {totals === null || !hasChanges
          ? 'Changes'
          : `Changes +${String(totals.added)} −${String(totals.removed)}`}
      </Button>
    );
  const tabProps = { session, project, changes: control, quote };
  return (
    <Flex ref={sizeRef} style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
      <Flex direction="column" style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
        {session.place === 'pass' ? <PassTab {...tabProps} /> : <CopyTab {...tabProps} />}
      </Flex>
      {open ? (
        <ChangesPanel
          changes={changes}
          base={session.place === 'pass' ? 'the pass’s start' : null}
          scope={session.place === 'pass' ? { value: scope, onChange: setScope } : null}
          pullRequest={session.pullRequest?.url ?? null}
          onQuote={(text) => {
            setQuote((last) => ({ id: (last?.id ?? 0) + 1, text }));
          }}
          onClose={() => {
            setChoice(false);
          }}
        />
      ) : null}
    </Flex>
  );
}
