import { Stack, Text, Title } from '@mantine/core';

export function FactoryView() {
  return (
    <Stack>
      <Title order={2}>Factory</Title>
      <Text c="dimmed">No workstreams are running.</Text>
    </Stack>
  );
}
