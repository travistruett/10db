import { Button, Group, Modal, Stack, Text } from '@mantine/core';
import type { ReactNode } from 'react';

/**
 * Asks before an action that reaches outside 10db or can't be undone from here, such as a post in
 * Slack. Cancel takes the focus, so Enter never confirms by accident.
 */
export function ConfirmModal({
  opened,
  title,
  children,
  confirmLabel,
  loading = false,
  error = null,
  onConfirm,
  onCancel,
}: {
  readonly opened: boolean;
  readonly title: string;
  /** What the action does, in one or two plain sentences. */
  readonly children: ReactNode;
  readonly confirmLabel: string;
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <Modal opened={opened} onClose={onCancel} title={title} centered size="md">
      <Stack gap="xl">
        <Text size="sm">{children}</Text>
        <Group justify="flex-end" gap="sm">
          {error === null ? null : (
            <Text size="xs" c="red" style={{ flex: 1 }}>
              {error}
            </Text>
          )}
          <Button variant="default" data-autofocus onClick={onCancel}>
            Cancel
          </Button>
          <Button color="red" loading={loading} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
