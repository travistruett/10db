import { Stack, Text, Title } from '@mantine/core';

export function InboxView() {
  return (
    <Stack>
      <Title order={2}>Inbox</Title>
      <Text c="dimmed">Nothing needs you right now.</Text>
    </Stack>
  );
}
