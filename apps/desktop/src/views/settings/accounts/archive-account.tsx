import { accountDisplayName, type AccountDto } from '@10db/contracts';
import { Alert, Button, Group, Modal, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import { useArchiveAccount } from '../../../daemon/account-queries';

/**
 * Archiving an account after a confirmation. The default account offers none: the daemon refuses it.
 * A refused archive shows the daemon's reason, which names the projects to move first.
 */
export function ArchiveAccount({
  account,
  onArchived,
}: {
  readonly account: AccountDto;
  readonly onArchived: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const archive = useArchiveAccount();
  if (account.isDefault) return <Text c="dimmed">The default account can&apos;t be archived.</Text>;
  const name = accountDisplayName(account);
  const close = () => {
    setConfirming(false);
    archive.reset();
  };
  const confirm = async () => {
    try {
      await archive.mutateAsync(account.id);
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
          setConfirming(true);
        }}
      >
        Archive account
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
              Archive account
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
