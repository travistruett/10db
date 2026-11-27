import { Button, CloseButton, Group, Paper, Text } from '@mantine/core';
import { useRouterState } from '@tanstack/react-router';
import { useState } from 'react';
import { PushState, usePushSwitch } from './push-subscription';
import classes from './served-frame.module.css';

/** Where a Not Now is kept, so the banner stays away on this phone until notifications are turned on elsewhere. */
const DISMISSED_KEY = 'tendb.pushBannerDismissed';

function dismissedBefore(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * The phone Inbox's one-tap offer of notifications, shown only while this phone could have them and doesn't. Not Now
 * keeps it away on this phone; Settings › This Device keeps the switch.
 */
export function PushBanner() {
  const onInbox = useRouterState({
    select: (state) => state.location.pathname.startsWith('/inbox'),
  });
  const push = usePushSwitch();
  const [dismissed, setDismissed] = useState(dismissedBefore);
  if (!onInbox || dismissed || push.state !== PushState.Off) return null;
  return (
    <Paper withBorder radius="md" p="sm" className={classes['pushBanner']}>
      <Group justify="space-between" wrap="nowrap" gap="sm">
        <Text size="sm">Get a buzz when an agent needs you.</Text>
        <Group gap={4} wrap="nowrap">
          <Button
            size="compact-sm"
            loading={push.busy}
            onClick={() => {
              push.toggle(true);
            }}
          >
            Turn On
          </Button>
          <CloseButton
            aria-label="Not now"
            onClick={() => {
              try {
                localStorage.setItem(DISMISSED_KEY, '1');
              } catch {
                // Kept for this page only.
              }
              setDismissed(true);
            }}
          />
        </Group>
      </Group>
      {push.error === null ? null : (
        <Text size="xs" c="red" role="alert" mt={4}>
          {push.error}
        </Text>
      )}
    </Paper>
  );
}
