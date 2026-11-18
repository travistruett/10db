import type { ArchivePreviewDto } from '@10db/contracts';
import { Button, Group, List, Modal, Text } from '@mantine/core';

export interface ArchiveConfirmProps {
  /** What archiving would delete; null while nothing asks. */
  readonly preview: ArchivePreviewDto | null;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (preview: ArchivePreviewDto) => void;
}

/** Archive's warning (sessions spec §4.4): what is lost with the worktree, and that the commits stay. */
export function ArchiveConfirm({ preview, pending, onCancel, onConfirm }: ArchiveConfirmProps) {
  return (
    <Modal opened={preview !== null} onClose={onCancel} title="Archive this session?" centered>
      {preview === null ? null : (
        <>
          <Text size="sm">
            {preview.branch === null
              ? 'Archive removes the session’s worktree.'
              : `Archive removes the worktree of ${preview.branch}.`}{' '}
            These files are not saved anywhere else and will be lost. Your commits stay on the
            branch.
          </Text>
          <List size="sm" mt="xs" aria-label="Files that will be lost">
            {[...preview.uncommitted, ...preview.ignored].map((path) => (
              <List.Item key={path}>{path}</List.Item>
            ))}
          </List>
          <Group justify="flex-end" gap="xs" mt="md">
            <Button variant="subtle" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              color="red"
              data-autofocus
              loading={pending}
              onClick={() => {
                onConfirm(preview);
              }}
            >
              Archive and Delete These Files
            </Button>
          </Group>
        </>
      )}
    </Modal>
  );
}
