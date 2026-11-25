import { ActionIcon, Button, Menu, Tooltip } from '@mantine/core';
import { IconDots, IconX } from '@tabler/icons-react';
import { SplitButton } from '../../shell/split-button';

/**
 * What a failure offers, as one control: Retry with Close in its menu where the daemon takes a retry, Retry
 * alone where it takes no close, and only a ⋯ menu with Close where it takes no retry. The row itself opens
 * the task, so there is no Open. Plural labels serve a cause's Retry All and Close All.
 */
export function FailureActions({
  retryLabel = 'Retry',
  closeLabel = 'Close Task',
  canRetry,
  canClose,
  retrying = false,
  closing = false,
  onRetry,
  onClose,
}: {
  readonly retryLabel?: string;
  readonly closeLabel?: string;
  readonly canRetry: boolean;
  readonly canClose: boolean;
  readonly retrying?: boolean;
  readonly closing?: boolean;
  readonly onRetry: () => void;
  readonly onClose: () => void;
}) {
  const closeItem = (
    <Menu.Item leftSection={<IconX size={14} stroke={1.5} />} disabled={closing} onClick={onClose}>
      {closeLabel}
    </Menu.Item>
  );
  if (canRetry && canClose) {
    return (
      <SplitButton
        size="xs"
        loading={retrying}
        onClick={onRetry}
        menuLabel="More actions"
        menu={closeItem}
      >
        {retryLabel}
      </SplitButton>
    );
  }
  if (canRetry) {
    return (
      <Button size="xs" loading={retrying} onClick={onRetry}>
        {retryLabel}
      </Button>
    );
  }
  if (!canClose) return null;
  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <Tooltip label="More actions">
          <ActionIcon variant="subtle" color="gray" aria-label="More actions" loading={closing}>
            <IconDots size={16} stroke={1.5} />
          </ActionIcon>
        </Tooltip>
      </Menu.Target>
      <Menu.Dropdown>{closeItem}</Menu.Dropdown>
    </Menu>
  );
}
