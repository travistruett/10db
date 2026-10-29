import type { AccountDto } from '@10db/contracts';
import { Alert, Button, Group, Modal, Stack, Text } from '@mantine/core';
import { useEffect } from 'react';
import { useArchiveAccount } from '../../../daemon/account-queries';

/**
 * Archiving an account after a confirmation. The default account offers none: the daemon refuses it.
 * A refused archive shows the daemon's reason, which names the projects to move first.
 * The confirmation's open state belongs to the caller, so the drawer around it can ignore the
 * Escape that closes the confirmation.
 */
export function ArchiveAccount({
  account,
  confirming,
  onConfirmingChange,
  onArchived,
}: {
  readonly account: AccountDto;
  readonly confirming: boolean;
  readonly onConfirmingChange: (confirming: boolean) => void;
  readonly onArchived: () => void;
}) {
  const archive = useArchiveAccount();
  // The caller keeps the flag, so it must not outlive this component (the account was archived
  // elsewhere, or the drawer moved to another account).
  useEffect(
    () => () => {
      onConfirmingChange(false);
    },
    [onConfirmingChange],
  );
  if (account.isDefault) return <Text c="dimmed">The default account can&apos;t be archived.</Text>;
  const name = account.label;
  const close = () => {
    onConfirmingChange(false);
    archive.reset();
  };
  const confirm = async () => {
    try {
      await archive.mutateAsync(account.id);
      onConfirmingChange(false);
      onArchived();
    } catch {
      // The mutation's error is shown in the modal.
    }
  };
  return (
    <>
      <Button
        size="md"
        variant="outline"
        color="red"
        onClick={() => {
          onConfirmingChange(true);
        }}
      >
        Archive Account
      </Button>
      <Modal
        opened={confirming}
        onClose={close}
        title={`Archive ${name}?`}
        size="md"
        closeButtonProps={{ 'aria-label': 'Close' }}
      >
        <Stack gap="md">
          <Text>{name} stops taking projects. Archived accounts can&apos;t be restored.</Text>
          {archive.isError ? (
            <Alert color="red" role="alert">
              {archive.error.message}
            </Alert>
          ) : null}
          <Group justify="flex-end">
            <Button size="md" variant="default" onClick={close}>
              Cancel
            </Button>
            <Button
              size="md"
              color="red"
              loading={archive.isPending}
              onClick={() => void confirm()}
            >
              Archive Account
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
