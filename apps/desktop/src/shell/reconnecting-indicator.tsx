import { Badge, Box, HoverCard, Stack, Text } from '@mantine/core';
import { useDaemonStatus } from '../daemon/provider';
import { absoluteTime, fromNow, useNow } from './relative';

/** How long the connection is lost before the pill shows, so a daemon restart doesn't flash it. */
const SHOW_AFTER_MS = 5_000;
/** From here the pill says how long it has been. */
const ELAPSED_AFTER_MS = 2 * 60_000;
/** How often the pill checks the time while the connection is lost: it appears within a second of the delay. */
const TICK_MS = 1_000;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** "3m", or "2h" from an hour on: the pill's short form of how long the connection has been lost. */
function shortElapsed(ms: number): string {
  return ms < HOUR_MS
    ? `${String(Math.floor(ms / MINUTE_MS))}m`
    : `${String(Math.floor(ms / HOUR_MS))}h`;
}

/**
 * The frame's one sign that the daemon is unreachable: nothing while connected or for the first few seconds of an
 * outage, then a quiet pill at the right of the title row whose hover card says what it means. The provider retries
 * every second on its own, so there is nothing for the builder to press.
 */
export function ReconnectingIndicator() {
  const status = useDaemonStatus();
  if (status.kind !== 'reconnecting') return null;
  return <ReconnectingPill since={status.since} />;
}

function ReconnectingPill({ since }: { readonly since: number }) {
  const now = useNow(TICK_MS);
  const elapsed = now - since;
  if (elapsed < SHOW_AFTER_MS) return null;
  const label =
    elapsed < ELAPSED_AFTER_MS ? 'Reconnecting…' : `Reconnecting · ${shortElapsed(elapsed)}`;
  return (
    <HoverCard position="bottom-end" width={280} withArrow openDelay={150}>
      <HoverCard.Target>
        <Badge
          role="status"
          variant="light"
          color="gray"
          size="lg"
          radius="xl"
          tt="none"
          fw={500}
          tabIndex={0}
          // After the title row's spacer and before the view's actions (`app-frame.module.css`).
          style={{ flex: 'none', order: 1, cursor: 'default' }}
          leftSection={
            <Box
              aria-hidden
              w={8}
              h={8}
              bg="var(--mantine-color-yellow-filled)"
              style={{ borderRadius: '50%' }}
            />
          }
        >
          {label}
        </Badge>
      </HoverCard.Target>
      <HoverCard.Dropdown>
        <Stack gap={4}>
          <Text size="sm" fw={500}>
            Reconnecting to the daemon
          </Text>
          <Text size="xs" c="dimmed" title={absoluteTime(since)}>
            Work keeps running. Lost the connection {fromNow(since, now)}. 10db tries again every
            second on its own.
          </Text>
        </Stack>
      </HoverCard.Dropdown>
    </HoverCard>
  );
}
