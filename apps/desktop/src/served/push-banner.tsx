import { Button, CloseButton, Group, Paper, Text } from '@mantine/core';
import { useElementSize } from '@mantine/hooks';
import { useRouterState } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { PushState, usePushSwitch } from './push-subscription';
import classes from './served-frame.module.css';

/** Where a Not Now is kept: the banner stays away on this phone for good, and This Device keeps the switch. */
const DISMISSED_KEY = 'tendb.pushBannerDismissed';
/** The space the list sheet leaves at its foot for the banner (`served-frame.module.css`). */
const SPACE_VAR = '--push-banner-space';
/** The banner's bottom margin, which the space includes. */
const BANNER_MARGIN = 8;

function dismissedBefore(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * The phone Inbox's one-tap offer of notifications, shown only while this phone could have them and doesn't. It
 * reads the browser's state on each visit to the Inbox, so a change made in This Device shows on the way back.
 */
export function PushBanner() {
  const onInbox = useRouterState({
    select: (state) => state.location.pathname.startsWith('/inbox'),
  });
  return onInbox ? <InboxPushBanner /> : null;
}

function InboxPushBanner() {
  const push = usePushSwitch();
  const [dismissed, setDismissed] = useState(dismissedBefore);
  const { ref, height } = useElementSize();
  const shown = !dismissed && push.state === PushState.Off;
  // The list sheet stands over the content, so its foot is moved up by the banner's height while it shows.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty(SPACE_VAR, shown ? `${String(height + BANNER_MARGIN)}px` : '0px');
    return () => {
      root.style.removeProperty(SPACE_VAR);
    };
  }, [shown, height]);
  if (!shown) return null;
  return (
    <Paper ref={ref} withBorder radius="md" p="sm" className={classes['bottomBanner']}>
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
