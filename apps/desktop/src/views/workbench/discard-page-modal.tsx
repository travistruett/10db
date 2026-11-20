import type { PassId, TaskId } from '@10db/contracts';
import { Button, Loader, Stack, Text } from '@mantine/core';
import { useTakeOutPreview } from '../../daemon/pass-close-queries';
import { FormModal } from '../../shell/form-modal';
import { useDiscardPage } from './discard-page';

export interface DiscardPageModalProps {
  readonly passId: PassId;
  readonly taskId: TaskId;
  /** The page's name. */
  readonly label: string;
  readonly onClose: () => void;
}

/**
 * Discard Page's confirm (Workbench spec §5.4, §7.2): the page's changes are deleted and its files go
 * back to how they were before the pass; a task 10db made for the page leaves the Board, and one brought
 * in from the Board goes back to it. A shared change that something later stands on cannot be dropped,
 * so it stays, with the daemon's reason.
 */
export function DiscardPageModal({ passId, taskId, label, onClose }: DiscardPageModalProps) {
  const preview = useTakeOutPreview({ passId, taskId });
  const discard = useDiscardPage({ passId, taskId, label });
  const stays = (preview.data?.shared ?? []).filter((change) => change.dropRefusal !== null);
  return (
    <FormModal
      opened
      onClose={onClose}
      title="Discard Page"
      size="md"
      error={discard.error?.message ?? preview.error?.message ?? null}
      actions={
        <>
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            color="red"
            loading={discard.isPending}
            disabled={preview.data === undefined}
            onClick={() => {
              discard.mutate(preview.data?.shared ?? [], {
                onSuccess: onClose,
                // What the daemon offers is read again, since a refused Drop means the changes moved.
                onError: () => {
                  void preview.refetch();
                },
              });
            }}
          >
            Discard Page
          </Button>
        </>
      }
    >
      <Stack gap="sm">
        <Text size="sm">
          {`Discard the ${label} page? Only this page: its changes are deleted and its files go back to how they were before this pass, and the rest of the pass goes on. A turn that is working stops.`}
        </Text>
        <Text size="sm" c="dimmed">
          If 10db made its Board task for this pass, the task is removed; a task you brought in from
          the Board goes back there.
        </Text>
        {preview.isPending ? (
          <Loader size="xs" role="status" aria-label="Reading its shared changes" />
        ) : stays.length === 0 ? null : (
          <Stack gap={4}>
            <Text size="sm">Stays, because other pages are built on it:</Text>
            {stays.map((change) => (
              <Text key={change.seq} size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
                {`${change.paths.join(', ')}: ${change.dropRefusal ?? ''}`}
              </Text>
            ))}
          </Stack>
        )}
      </Stack>
    </FormModal>
  );
}
