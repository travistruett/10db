import { Stack, Text } from '@mantine/core';
import { AaCard } from './aa-card';
import { SlackCard } from './slack-card';

/**
 * Settings › Integrations: one card per outside service that isn't a model, each set up once. GitHub's card
 * comes first and joins in its own change.
 */
export function IntegrationsSection() {
  return (
    <Stack>
      <Text c="dimmed" size="sm">
        Outside services 10db uses that aren't models. Model access is in Accounts.
      </Text>
      <SlackCard />
      <AaCard />
    </Stack>
  );
}
