import type { FolderDto, ProjectId } from '@10db/contracts';
import { Button, Group, Text } from '@mantine/core';
import { useCancelPendingOpen } from '../../daemon/pending-open-queries';

/**
 * "Opens when the chat ‘X’ ends its turn · Cancel": a pass waiting for Your folder, on the Workbench and
 * the chat's bar. It goes when the folder route drops it.
 */
export function PendingOpenLine({ folder }: { readonly folder: FolderDto | null }) {
  const pending = folder?.pendingOpen ?? null;
  if (folder === null || pending === null) return null;
  return <WaitingLine projectId={folder.projectId} waitsFor={pending.waitsFor} />;
}

function WaitingLine({
  projectId,
  waitsFor,
}: {
  readonly projectId: ProjectId;
  readonly waitsFor: string;
}) {
  const cancel = useCancelPendingOpen();
  return (
    <Group gap="xs" wrap="nowrap" px="md" role="status">
      <Text size="xs" c="dimmed" lineClamp={1}>
        Opens when {waitsFor} ends its turn
      </Text>
      <Button
        size="compact-xs"
        variant="subtle"
        loading={cancel.isPending}
        onClick={() => {
          cancel.mutate(projectId);
        }}
      >
        Cancel
      </Button>
      {cancel.error === null ? null : (
        <Text size="xs" c="red">
          {cancel.error.message}
        </Text>
      )}
    </Group>
  );
}
