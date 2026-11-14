import type { TaskId } from '@10db/contracts';
import { Button, Group, Text } from '@mantine/core';
import { useState } from 'react';
import { useDiscardKeptWork } from '../../daemon/pass-queries';
import { FormModal } from '../../shell/form-modal';

/**
 * The task drawer's word on work the task kept from a Workbench pass (Workbench spec §5.4), which its
 * next start puts back, and Discard Saved Work to drop it after a confirm.
 */
export function KeptWork({ taskId }: { readonly taskId: TaskId }) {
  const [confirming, setConfirming] = useState(false);
  const discard = useDiscardKeptWork(taskId);
  const close = () => {
    setConfirming(false);
    discard.reset();
  };
  return (
    <Group gap="sm" wrap="wrap">
      <Text size="sm" c="dimmed">
        Has saved UI Workbench work: its next start puts it back.
      </Text>
      <Button
        size="compact-sm"
        variant="default"
        onClick={() => {
          setConfirming(true);
        }}
      >
        Discard Saved Work
      </Button>
      <FormModal
        opened={confirming}
        onClose={close}
        title="Discard Saved Work"
        size="md"
        error={discard.error?.message ?? null}
        actions={
          <>
            <Button variant="default" onClick={close}>
              Cancel
            </Button>
            <Button
              color="red"
              loading={discard.isPending}
              onClick={() => {
                discard.mutate(undefined, { onSuccess: close });
              }}
            >
              Discard Saved Work
            </Button>
          </>
        }
      >
        <Text size="sm">
          Discard the work this task kept from its UI Workbench pass? Its next start begins without
          it. This can't be undone.
        </Text>
      </FormModal>
    </Group>
  );
}
