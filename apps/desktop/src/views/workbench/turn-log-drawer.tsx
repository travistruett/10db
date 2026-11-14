import type { PassTurnId } from '@10db/contracts';
import { Alert, Drawer, Group, Loader, Stack, Text } from '@mantine/core';
import { useTurnActivity } from '../../daemon/pass-queries';
import { clockTime } from './page-status';

export interface TurnLogDrawerProps {
  readonly turnId: PassTurnId;
  /** "Billing · Turn 1". */
  readonly title: string;
  readonly opened: boolean;
  readonly onClose: () => void;
}

/** Show Log (Workbench spec §4.3): the working turn's full activity, read when it opens. */
export function TurnLogDrawer({ turnId, title, opened, onClose }: TurnLogDrawerProps) {
  const activity = useTurnActivity(turnId, opened);
  return (
    <Drawer opened={opened} onClose={onClose} position="right" title={title}>
      {activity.isPending ? <Loader size="sm" aria-label="Loading the log" /> : null}
      {activity.isError ? (
        <Alert color="red" title="Couldn't load the log">
          {activity.error.message}
        </Alert>
      ) : null}
      {activity.isSuccess && activity.data.length === 0 ? (
        <Text size="sm" c="dimmed">
          Nothing is logged for this turn yet.
        </Text>
      ) : null}
      {activity.isSuccess ? (
        <Stack gap={4}>
          {activity.data.map((row, index) => (
            // Rows have no id and never reorder: the log only grows at its end.
            <Group key={index} gap="sm" wrap="nowrap" align="baseline">
              <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                {clockTime(row.at)}
              </Text>
              <Text size="sm">{row.summary}</Text>
            </Group>
          ))}
        </Stack>
      ) : null}
    </Drawer>
  );
}
