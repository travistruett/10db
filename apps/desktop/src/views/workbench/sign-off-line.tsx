import type { PassId, TaskId } from '@10db/contracts';
import { Button, Group, Text } from '@mantine/core';
import { useCancelSignOff } from '../../daemon/pass-close-queries';

export interface SignOffLineProps {
  readonly passId: PassId;
  readonly taskId: TaskId;
  /** "Signing off…", or whose turn the sign-off waits for. */
  readonly line: string;
  /** The sign-off waits for another page's turn, so it can be withdrawn. */
  readonly waiting: boolean;
}

/**
 * A page's sign-off under way, at the foot of its thread (Workbench spec §9.2). One that waits for
 * another page's turn offers Cancel Sign-Off, which leaves the page Ready; one landing now has nothing
 * to cancel.
 */
export function SignOffLine({ passId, taskId, line, waiting }: SignOffLineProps) {
  const cancel = useCancelSignOff();
  return (
    <Group gap="sm" px="md" py="xs" wrap="nowrap" align="center">
      <Text size="sm" c={cancel.error ? 'red' : 'dimmed'} style={{ flex: 1, minWidth: 0 }}>
        {cancel.error?.message ?? line}
      </Text>
      {waiting ? (
        <Button
          variant="default"
          loading={cancel.isPending}
          onClick={() => {
            cancel.mutate({ passId, taskId });
          }}
        >
          Cancel Sign-Off
        </Button>
      ) : null}
    </Group>
  );
}
