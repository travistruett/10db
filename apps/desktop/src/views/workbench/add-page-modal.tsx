import type {
  PassJoinRequest,
  PassStartDto,
  PassViewDto,
  ProjectViewDto,
  TaskDto,
} from '@10db/contracts';
import { Button, Loader, Stack, Textarea } from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { FormModal } from '../../shell/form-modal';
import { PagePicker } from './page-picker';
import { StartLines } from './start-lines';
import { joinableTasks, type PickTicks } from './start-pass-rules';

export interface AddPageModalProps {
  readonly project: ProjectViewDto;
  readonly view: PassViewDto;
  /** What the picker lists and Start Pass says; undefined until read. */
  readonly start: PassStartDto | undefined;
  /** The project's tasks; the open ones that work on a page are offered. */
  readonly tasks: readonly TaskDto[];
  /** Now, in epoch milliseconds. */
  readonly now: number;
  readonly onClose: () => void;
  /** Adds the pages: `POST /passes/:passId/pages`. */
  readonly add: (request: PassJoinRequest) => Promise<unknown>;
}

/**
 * Add Page (Workbench spec §4.3): the picker's rows for the pages the pass lacks and the tasks that
 * could join, what the ticked pages take in, and an optional first message. Nothing may share a file
 * with a page the pass holds, and the pass never grows past its most pages.
 */
export function AddPageModal({
  project,
  view,
  start,
  tasks,
  now,
  onClose,
  add,
}: AddPageModalProps) {
  const [ticks, setTicks] = useState<PickTicks>({ pages: [], tasks: [] });
  const [message, setMessage] = useState('');
  const adding = useMutation({
    mutationFn: (request: PassJoinRequest) => add(request),
    onSuccess: onClose,
  });
  const count = ticks.pages.length + ticks.tasks.length;
  const firstMessage = message.trim();
  return (
    <FormModal
      opened
      onClose={onClose}
      title="Add Page"
      error={adding.error?.message ?? null}
      actions={
        <>
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={count === 0}
            loading={adding.isPending}
            onClick={() => {
              adding.mutate({
                pages: [...ticks.pages],
                taskIds: ticks.tasks.map((task) => task.taskId),
                firstMessage: firstMessage === '' ? null : firstMessage,
              });
            }}
          >
            Add Pages
          </Button>
        </>
      }
    >
      {start === undefined ? (
        <Loader size="sm" role="status" aria-label="Loading the pages" />
      ) : (
        <Stack gap="md">
          <PagePicker
            pages={start.pages}
            tasks={joinableTasks(tasks, project.areas)}
            areas={project.areas}
            ticks={ticks}
            onTicks={setTicks}
            now={now}
            inPass={view.pages.map((page) => page.area)}
          />
          <Textarea
            label="First message"
            description="Sent to each new page. Left empty, each waits for yours."
            autosize
            minRows={1}
            maxRows={6}
            value={message}
            onChange={(event) => {
              setMessage(event.currentTarget.value);
            }}
          />
          <StartLines ticks={ticks} start={start} project={project} />
        </Stack>
      )}
    </FormModal>
  );
}
