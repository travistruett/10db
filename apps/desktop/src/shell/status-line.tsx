import { ActionIcon, Group, Popover, Stack, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { IconPlayerPause } from '@tabler/icons-react';
import { useStatus } from '../daemon/status-queries';
import { useRailMode } from './rail-mode';

/**
 * What is holding work back and ends by itself, at the rail's foot: the oldest hold's sentence, "+N" when
 * more, and a popover with every hold's details and the busiest processes behind it. It draws nothing while
 * nothing is held, and never asks the builder to do anything: the daemon decides when a hold is shown.
 */
export function StatusLineControl() {
  const { labels } = useRailMode();
  const lines = useStatus().data?.lines ?? [];
  const [first, ...more] = lines;
  if (first === undefined) return null;
  const name = more.length === 0 ? first.line : `${first.line} (+${String(more.length)} more)`;
  return (
    <Popover position="right-end" width={340} shadow="md" withArrow>
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
                {first.line}
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
        <Stack gap="md">
          {lines.map((status) => (
            <Stack key={status.key} gap={4}>
              <Text size="sm" fw={500}>
                {status.line}
              </Text>
              <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>
                {status.details}
              </Text>
              {status.culprits.length > 0 && (
                <Stack gap={0}>
                  {status.culprits.map((culprit) => (
                    <Text key={culprit.name} size="xs" c="dimmed" lineClamp={1}>
                      {`${culprit.name}: ${String(culprit.cpuPct)}% of a core`}
                    </Text>
                  ))}
                </Stack>
              )}
            </Stack>
          ))}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
