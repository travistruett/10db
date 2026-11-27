import { DevicePlatform } from '@10db/contracts';
import { Button, Paper, Stack, Text } from '@mantine/core';
import { useElementSize } from '@mantine/hooks';
import { useEffect, useState } from 'react';
import { useDaemonStatus } from '../daemon/provider';
import { thisPlatform } from './pairing';
import classes from './served-frame.module.css';

/** How long the phone must have failed to reach the Mac before it says so: a blip is ridden out by the pill. */
export const CANT_REACH_AFTER_MS = 10_000;
/** The space the list sheet leaves at its foot for the banner (`served-frame.module.css`). */
const SPACE_VAR = '--cant-reach-space';
const BANNER_MARGIN = 8;
/** Opens the Tailscale app on Android; Chrome falls back to the Play Store page when it isn't installed. */
const OPEN_TAILSCALE_ANDROID = 'intent://#Intent;package=com.tailscale.ipn;end';

/** True once `since` is at least `afterMs` ago, re-checked when that moment comes. */
function usePassed(since: number | null, afterMs: number): boolean {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return undefined;
    const timer = setTimeout(
      () => {
        setNow(Date.now());
      },
      Math.max(0, since + afterMs - Date.now()),
    );
    return () => {
      clearTimeout(timer);
    };
  }, [since, afterMs]);
  return since !== null && now - since >= afterMs;
}

/**
 * What to do when the phone can't reach the Mac: it reaches it only over Tailscale, so the usual cause is
 * Tailscale off on the phone or the Mac asleep. Android gets a button that opens Tailscale; iOS can't be sent
 * there from a web page, so it gets the words.
 */
export function CantReachMacHelp() {
  const platform = thisPlatform().platform;
  return (
    <Stack gap={6}>
      <Text size="sm" fw={600}>
        Can't reach your Mac
      </Text>
      <Text size="sm" c="dimmed">
        {platform === DevicePlatform.Ios
          ? 'This phone reaches your Mac over Tailscale. Open the Tailscale app and check it is connected, and that your Mac is awake. 10db keeps trying.'
          : 'This phone reaches your Mac over Tailscale. Check Tailscale is connected on this phone, and that your Mac is awake. 10db keeps trying.'}
      </Text>
      {platform === DevicePlatform.Android ? (
        <Button component="a" href={OPEN_TAILSCALE_ANDROID} size="compact-sm" w="fit-content">
          Open Tailscale
        </Button>
      ) : null}
    </Stack>
  );
}

/** The help in a banner above the places, once the phone has been reconnecting for `CANT_REACH_AFTER_MS`. */
export function CantReachMacBanner() {
  const status = useDaemonStatus();
  const shown = usePassed(
    status.kind === 'reconnecting' ? status.since : null,
    CANT_REACH_AFTER_MS,
  );
  const { ref, height } = useElementSize();
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
    <Paper ref={ref} withBorder radius="md" p="sm" className={classes['pushBanner']} role="status">
      <CantReachMacHelp />
    </Paper>
  );
}
