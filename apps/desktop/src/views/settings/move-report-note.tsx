import { Alert, Button, Group, List, Stack, Text } from '@mantine/core';
import { useDismissPlaybookMoveReport, usePlaybookMoveReport } from '../../daemon/playbook-queries';

/**
 * The settings that could not carry over to the playbook, each with what it was and why. It shows until the
 * builder dismisses it, and shows nothing when everything moved.
 */
export function MoveReportNote() {
  const report = usePlaybookMoveReport();
  const dismiss = useDismissPlaybookMoveReport();
  const entries = report.data ?? [];
  if (entries.length === 0) return null;
  return (
    <Alert
      color="yellow"
      variant="light"
      title="Some settings could not carry over"
      role="region"
      aria-label="Settings that did not carry over"
    >
      <Stack gap="xs">
        <Text size="sm">
          These settings from before the playbook have no place in it, so 10db no longer uses them.
        </Text>
        <List size="sm" spacing={4}>
          {entries.map((entry) => (
            <List.Item key={`${entry.setting}:${entry.value}`}>
              <Text size="sm" span fw={500}>
                {entry.setting}
              </Text>
              {entry.value === '' ? '' : `: ${entry.value}`}. {entry.why}
            </List.Item>
          ))}
        </List>
        {dismiss.isError ? (
          <Text size="xs" c="red" role="alert">
            {dismiss.error.message}
          </Text>
        ) : null}
        <Group justify="flex-end">
          <Button
            size="xs"
            variant="default"
            loading={dismiss.isPending}
            onClick={() => {
              dismiss.mutate();
            }}
          >
            Dismiss
          </Button>
        </Group>
      </Stack>
    </Alert>
  );
}
