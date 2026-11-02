import type { WorkstreamId } from '@10db/contracts';
import { Alert, Button, Group, Modal, Stack, Text } from '@mantine/core';
import { useCancelWorkstream } from '../../daemon/queries';

export interface CancelRunModalProps {
  /** The run to cancel; null while the confirm is closed. */
  readonly run: { readonly id: WorkstreamId; readonly taskTitle: string } | null;
  readonly onClose: () => void;
}

/** The confirm before a run is cancelled, from a card's menu or the task drawer. */
export function CancelRunModal({ run, onClose }: CancelRunModalProps) {
  const cancel = useCancelWorkstream();
  const close = () => {
    cancel.reset();
    onClose();
  };
  return (
    <Modal opened={run !== null} onClose={close} title="Cancel this workstream?">
      <Stack>
        <Text size="sm">
          The session stops and its claims are released. {run ? `Task: ${run.taskTitle}` : ''}
        </Text>
        {cancel.error ? (
          <Alert color="red" title="The daemon refused that">
            {cancel.error.message}
          </Alert>
        ) : null}
        <Group justify="flex-end">
          <Button variant="default" onClick={close}>
            Keep running
          </Button>
          <Button
            color="red"
            loading={cancel.isPending}
            onClick={() => {
              if (!run) return;
              cancel.mutate(run.id, { onSuccess: close });
            }}
          >
            Cancel workstream
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
