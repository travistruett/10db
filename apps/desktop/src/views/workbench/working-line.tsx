import type { PassTurnId } from '@10db/contracts';
import { Anchor, Box, Group, Text } from '@mantine/core';
import { useState } from 'react';
import { StatusDot } from '../factory/status-dot';
import type { LiveLine } from './live-line';
import { TurnLogDrawer } from './turn-log-drawer';

export interface WorkingLineProps {
  readonly line: LiveLine;
  readonly turnId: PassTurnId;
  /** The log's title: "Billing · Turn 1". */
  readonly logTitle: string;
}

/**
 * The working turn's line at the end of the thread: a blue dot, the time and what the agent is doing,
 * and the files changed so far beside Show Log, which opens the turn's log. It changes as the agent
 * works, so it is not a live region.
 */
export function WorkingLine({ line, turnId, logTitle }: WorkingLineProps) {
  const [logOpen, setLogOpen] = useState(false);
  return (
    <Box px="md" pb="sm">
      <Group gap="xs" wrap="nowrap" align="baseline">
        <StatusDot color="blue" />
        <Text size="sm" truncate="end">
          {line.doing}
        </Text>
      </Group>
      <Group gap={4} pl={16} wrap="nowrap" align="baseline">
        {line.files === null ? null : (
          <>
            <Text size="xs" c="dimmed">
              {line.files}
            </Text>
            <Text size="xs" c="dimmed" aria-hidden="true">
              ·
            </Text>
          </>
        )}
        <Anchor
          component="button"
          type="button"
          size="xs"
          onClick={() => {
            setLogOpen(true);
          }}
        >
          Show Log
        </Anchor>
      </Group>
      <TurnLogDrawer
        turnId={turnId}
        title={logTitle}
        opened={logOpen}
        onClose={() => {
          setLogOpen(false);
        }}
      />
    </Box>
  );
}
