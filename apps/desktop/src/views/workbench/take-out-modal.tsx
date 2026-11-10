import type { TakeOutResultDto } from '@10db/contracts';
import { Button, Stack, Text } from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import { FormModal } from '../../shell/form-modal';

export interface TakeOutModalProps {
  /** The page's name. */
  readonly area: string;
  readonly onClose: () => void;
  /** Takes the page out: its route in the daemon, every shared change kept. */
  readonly takeOut: () => Promise<TakeOutResultDto>;
}

/** What a take-out that stopped short says: the page stays, and why. */
function stillChangingLine(area: string, files: readonly string[]): string {
  return `${area} stays in the pass: its files kept changing (${files.join(', ')}). Try again once they settle.`;
}

/**
 * Take Out…'s confirm (Workbench spec §5.4): the page leaves the pass, its work kept with its task, and
 * its files go back to how they were before the pass. Every shared change it made stays.
 */
export function TakeOutModal({ area, onClose, takeOut }: TakeOutModalProps) {
  const taking = useMutation({
    mutationFn: () => takeOut(),
    onSuccess: (result) => {
      if (result.tookOut) onClose();
    },
  });
  const stopped = taking.data?.tookOut === false ? taking.data.stillChanging : null;
  return (
    <FormModal
      opened
      onClose={onClose}
      title={`Take Out ${area}`}
      size="md"
      error={taking.error?.message ?? (stopped === null ? null : stillChangingLine(area, stopped))}
      actions={
        <>
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={taking.isPending}
            onClick={() => {
              taking.mutate();
            }}
          >
            Take Out
          </Button>
        </>
      }
    >
      <Stack gap="sm">
        <Text size="sm">
          {`Take ${area} out of the pass? A turn that is working stops. Its task keeps the work for its next start, and its files go back to how they were before the pass.`}
        </Text>
        <Text size="sm" c="dimmed">
          Every shared change it made stays.
        </Text>
      </Stack>
    </FormModal>
  );
}
