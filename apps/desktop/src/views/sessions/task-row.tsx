import {
  BoardStatus,
  type ChatId,
  type ChatToolResult,
  type ProjectId,
  type TaskEditPrevious,
  type TaskId,
} from '@10db/contracts';
import { Box, Button, Group, Text } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useAllowed } from '../../conversation/row-state';
import { usePatchChat } from '../../daemon/chat-queries';
import { usePatchTask, useRemoveTask, useTasks } from '../../daemon/queries';

// Sessions UI spec §7.3, "Task rows": a chat's builder tools as one-line rows, with Open on Board and Undo.
// A row is not expandable. Undo removes an unstarted task, puts back an edit's old values, or restores the
// title; the daemon's refusal (a task that has started) is said in the row itself.

export interface TaskRowContext {
  readonly chatId: ChatId;
  readonly projectId: ProjectId;
}

/** What each field of a task is called in "Changed the title and the criteria". */
const FIELD_WORDS: Readonly<Record<keyof TaskEditPrevious, string>> = {
  title: 'the title',
  why: 'the why',
  description: 'the description',
  acceptanceCriteria: 'the criteria',
  rigor: 'the rigor',
  kinds: 'the kinds',
  kindsOff: 'the kinds taken off',
  effortPin: 'the effort',
  areas: 'the areas',
  landing: 'the landing',
};

/** "the title", "the title and the criteria", "the title, the why and the criteria". */
export function fieldsInWords(previous: TaskEditPrevious): string {
  const words = (Object.keys(previous) as (keyof TaskEditPrevious)[]).map((k) => FIELD_WORDS[k]);
  const last = words.pop();
  if (last === undefined) return 'the task';
  return words.length === 0 ? last : `${words.join(', ')} and ${last}`;
}

/** A task still sits where it can be taken back until its first run. */
const UNSTARTED: ReadonlySet<string> = new Set([BoardStatus.Backlog, BoardStatus.Ready]);

function Dot() {
  return (
    <Box
      aria-hidden="true"
      w={8}
      h={8}
      bg="var(--mantine-color-dimmed)"
      style={{ borderRadius: '50%', flex: 'none' }}
    />
  );
}

function OpenOnBoard({ taskId }: { readonly taskId: TaskId }) {
  return (
    <Button
      size="compact-xs"
      variant="subtle"
      renderRoot={(props) => <Link {...props} to="/board" search={{ task: taskId }} />}
    >
      Open on Board
    </Button>
  );
}

/** Whether the daemon can still take the task's change back: unknown reads as yes, and the daemon decides. */
function useUnstarted(projectId: ProjectId, taskId: TaskId | null): boolean {
  const tasks = useTasks(projectId);
  if (taskId === null) return false;
  const task = tasks.data?.find((t) => t.id === taskId);
  return task === undefined || UNSTARTED.has(task.boardStatus);
}

function useTaskTitle(projectId: ProjectId, taskId: TaskId): string | null {
  const tasks = useTasks(projectId);
  return tasks.data?.find((t) => t.id === taskId)?.title ?? null;
}

interface Line {
  readonly dot: boolean;
  readonly title: string;
  readonly meta: string;
  readonly board: TaskId | null;
  readonly undo: (() => Promise<unknown>) | null;
  /** What the row says once Undo has run. */
  readonly undone: string;
}

export function TaskRow({
  rowId,
  result,
  context,
}: {
  readonly rowId: string;
  readonly result: ChatToolResult;
  readonly context: TaskRowContext;
}) {
  const remove = useRemoveTask();
  const patchTask = usePatchTask();
  const patchChat = usePatchChat();
  const taskId = result.kind === 'title' ? null : result.taskId;
  const unstarted = useUnstarted(context.projectId, taskId);
  const startedTitle = useTaskTitle(context.projectId, taskId ?? ('' as TaskId));
  // Whether Undo has run outlives the row: a windowed list unmounts rows that scroll away.
  const [undone, markUndone] = useAllowed(`${rowId}:undone`);
  const [refusal, setRefusal] = useState<string | null>(null);

  const line = ((): Line => {
    switch (result.kind) {
      case 'task':
        return {
          dot: true,
          title: result.title,
          meta: `Added to ${result.column}`,
          board: result.taskId,
          undo: unstarted ? () => remove.mutateAsync(result.taskId) : null,
          undone: 'Removed',
        };
      case 'task_edit': {
        const { previous } = result;
        const any = Object.keys(previous).length > 0;
        return {
          dot: false,
          title: result.title,
          meta: `Changed ${fieldsInWords(previous)}`,
          board: result.taskId,
          undo:
            unstarted && any
              ? () => patchTask.mutateAsync({ taskId: result.taskId, patch: previous })
              : null,
          undone: 'Restored',
        };
      }
      case 'start':
        return {
          dot: false,
          title: `Started ${startedTitle ?? 'a task'}`,
          meta: '',
          board: result.taskId,
          undo: null,
          undone: '',
        };
      case 'title':
        return {
          dot: false,
          title: `Renamed this session to ‘${result.title}’`,
          meta: '',
          board: null,
          undo: () =>
            patchChat.mutateAsync({ chatId: context.chatId, title: result.previousTitle }),
          undone: 'Restored',
        };
    }
  })();

  const undo = (): void => {
    const run = line.undo;
    if (run === null) return;
    setRefusal(null);
    run().then(
      () => {
        markUndone();
      },
      (error: unknown) => {
        setRefusal(error instanceof Error ? error.message : String(error));
      },
    );
  };

  return (
    <Box>
      <Group gap={8} wrap="nowrap" mih={28}>
        {line.dot ? <Dot /> : null}
        <Text
          size="sm"
          lineClamp={1}
          td={undone && result.kind === 'task' ? 'line-through' : undefined}
          style={{ minWidth: 0, flex: '0 1 auto' }}
        >
          {line.title}
        </Text>
        {line.meta === '' ? null : (
          <Text size="xs" c="dimmed" style={{ flex: 'none' }}>
            {line.meta}
          </Text>
        )}
        <Box style={{ flex: 1 }} />
        {undone ? (
          <Text size="xs" c="dimmed" style={{ flex: 'none' }}>
            {line.undone}
          </Text>
        ) : (
          <>
            {line.board === null ? null : <OpenOnBoard taskId={line.board} />}
            {line.undo === null ? null : (
              <Button size="compact-xs" variant="subtle" onClick={undo}>
                Undo
              </Button>
            )}
          </>
        )}
      </Group>
      {refusal === null ? null : (
        <Text size="xs" c="red" pl={16}>
          {refusal}
        </Text>
      )}
    </Box>
  );
}
