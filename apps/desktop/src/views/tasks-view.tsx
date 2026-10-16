import { Stack, Text, Title } from '@mantine/core';

export function TasksView() {
  return (
    <Stack>
      <Title order={2}>Tasks</Title>
      <Text c="dimmed">No tasks yet.</Text>
    </Stack>
  );
}
