import {
  TaskStatus,
  WorkstreamState,
  type BatchDto,
  type TaskId,
  type WorkstreamDto,
} from '@10db/contracts';
import { Alert, Button, Group, Modal, Select, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import { useTasks } from '../../../daemon/queries';
import { useAddFixTask } from './use-start-work';

export interface AddFixTaskProps {
  readonly batch: BatchDto;
  readonly workstreams: readonly WorkstreamDto[];
  readonly opened: boolean;
  readonly onClose: () => void;
}

/** Joins one more task to a worktree batch that is open or failed, to fix what blocks its pull request. */
export function AddFixTask({ batch, workstreams, opened, onClose }: AddFixTaskProps) {
  const tasks = useTasks(batch.projectId);
  const add = useAddFixTask(batch.projectId);
  const [picked, setPicked] = useState<TaskId | null>(null);
  const stateOf = new Map(workstreams.map((w) => [w.id, w.state]));
  // An open, unparked task that is not running anywhere; a cancelled attempt does not count.
  const eligible = (tasks.data ?? []).filter((t) => {
    if (t.status !== TaskStatus.Open || t.boardColumnId !== null) return false;
    const state = t.workstreamId === null ? undefined : stateOf.get(t.workstreamId);
    return state === undefined || state === WorkstreamState.Cancelled;
  });
  // The Select offers only IDs from the list, so looking the string up gives back the branded ID without a cast.
  const byId = new Map<string, TaskId>(eligible.map((t) => [t.id, t.id]));
  return (
    <Modal opened={opened} onClose={onClose} title="Add a fix task">
      <Stack>
        <Text size="sm" c="dimmed">
          {`The task joins ${batch.title} and works in its worktree.`}
        </Text>
        <Select
          label="Task"
          placeholder={eligible.length === 0 ? 'No task is free to add' : 'Pick a task'}
          data={eligible.map((t) => ({ value: t.id, label: t.title }))}
          value={picked}
          onChange={(value) => {
            setPicked(value === null ? null : (byId.get(value) ?? null));
          }}
        />
        {add.error ? (
          <Alert color="red" title="Couldn't add the task">
            {add.error.message}
          </Alert>
        ) : null}
        <Group justify="flex-end">
          <Button
            disabled={picked === null}
            loading={add.isPending}
            onClick={() => {
              if (picked === null) return;
              add.mutate(
                { batchTitle: batch.title, batchId: batch.id, taskId: picked },
                { onSuccess: onClose },
              );
            }}
          >
            Add fix task
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
