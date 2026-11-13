import { Stack, Text } from '@mantine/core';
import { SlackCard } from './slack-card';

/** Settings › Integrations: one card per service 10db reaches people through, each set up once. */
export function IntegrationsSection() {
  return (
    <Stack>
      <Text c="dimmed" size="sm">
        The services 10db uses to reach the people who answer your questions.
      </Text>
      <SlackCard />
    </Stack>
  );
}
