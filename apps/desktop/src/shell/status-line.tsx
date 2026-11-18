import {
  ActionIcon,
  Box,
  Group,
  HoverCard,
  Popover,
  Progress,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { StatusKind, type BusyLevel, type StatusLine } from '@10db/contracts';
import { IconPlayerPause } from '@tabler/icons-react';
import { useStatus } from '../daemon/status-queries';
import { useRailMode } from './rail-mode';

/** Below this the Mac is not busy enough to say so. */
const BUSY_SHOWN_FROM = 0.5;

/**
 * What is holding work back, at the rail's foot. How busy the Mac is draws as a thin bar with no numbers
 * (hidden below half, full and orange while 10db holds new work) and a hovercard in plain words; the other
 * holds, which end by themselves, show their short label with a popover of details. It draws nothing while
 * nothing is held or busy, and never asks the builder to do anything: the daemon decides when a hold is shown.
 */
export function StatusLineControl() {
  const status = useStatus().data;
  const busy = status?.busy ?? null;
  const showBar = busy !== null && busy.level >= BUSY_SHOWN_FROM;
  const lines = (status?.lines ?? []).filter((line) => line.kind !== StatusKind.AdmissionHold);
  if (!showBar && lines.length === 0) return null;
  return (
    <Stack gap={4} w="100%">
      {showBar && <BusyBar busy={busy} />}
      {lines.length > 0 && <HoldLines lines={lines} />}
    </Stack>
  );
}

function BusyBar({ busy }: { busy: BusyLevel }) {
  const { labels } = useRailMode();
  const sentence = busy.holding
    ? 'Your Mac is too busy to start new work. 10db is waiting for it to calm down; work already running carries on.'
    : busy.level >= 1
      ? 'Your Mac is very busy. If it stays this busy for a few minutes, 10db waits before starting anything new.'
      : 'Your Mac is busy. 10db keeps working, and waits before starting anything new if it gets much busier.';
  return (
    <HoverCard position="right-end" width={280} shadow="md" withArrow>
      <HoverCard.Target>
        <Box px={labels ? 8 : 4} py={6} w={labels ? '100%' : 40}>
          <Progress
            size={4}
            value={busy.holding ? 100 : Math.min(100, busy.level * 100)}
            color={busy.holding ? 'orange' : 'gray'}
            aria-label={busy.holding ? 'Mac too busy' : 'Mac busy'}
          />
        </Box>
      </HoverCard.Target>
      <HoverCard.Dropdown>
        <Stack gap={6}>
          <Text size="sm">{sentence}</Text>
          {busy.holding && busy.busiest.length > 0 && (
            <Text size="xs" c="dimmed">{`Busiest right now: ${busy.busiest.join(', ')}`}</Text>
          )}
        </Stack>
      </HoverCard.Dropdown>
    </HoverCard>
  );
}

function HoldLines({ lines }: { lines: readonly StatusLine[] }) {
  const { labels } = useRailMode();
  const [first, ...more] = lines;
  if (first === undefined) return null;
  const name = more.length === 0 ? first.line : `${first.line} (+${String(more.length)} more)`;
  return (
    <Popover position="right-end" width={360} shadow="md" withArrow>
      <Popover.Target>
        {labels ? (
          <UnstyledButton aria-label={name} title={name} px={8} py={4} w="100%">
            <Group gap={8} wrap="nowrap">
              <IconPlayerPause
                size={18}
                stroke={1.6}
                color="var(--mantine-color-dimmed)"
                aria-hidden
              />
              <Text size="xs" c="dimmed" lineClamp={1}>
                {first.label}
              </Text>
              {more.length > 0 && (
                <Text size="xs" c="dimmed">
                  {`+${String(more.length)}`}
                </Text>
              )}
            </Group>
          </UnstyledButton>
        ) : (
          <Tooltip label={name} position="right" multiline w={260}>
            <ActionIcon variant="subtle" color="gray" w={40} h={34} aria-label={name}>
              <IconPlayerPause size={18} stroke={1.6} />
              {more.length > 0 && (
                <Text size="10px" ml={2} component="span">
                  {`+${String(more.length)}`}
                </Text>
              )}
            </ActionIcon>
          </Tooltip>
        )}
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="md" style={{ overflowWrap: 'anywhere' }}>
          {lines.map((status) => (
            <Stack key={status.key} gap={4}>
              <Text size="sm" fw={500}>
                {status.line}
              </Text>
              <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>
                {status.details}
              </Text>
            </Stack>
          ))}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
