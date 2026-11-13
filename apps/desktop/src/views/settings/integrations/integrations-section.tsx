import { Stack, Text } from '@mantine/core';
import { AaCard } from './aa-card';
import { GithubCard } from './github-card';
import { SlackCard } from './slack-card';

/**
 * Settings › Integrations: one card per outside service that isn't a model, each set up once.
 */
export function IntegrationsSection() {
  return (
    <Stack>
      <Text c="dimmed" size="sm">
        Outside services 10db uses that aren't models. Model access is in Accounts.
      </Text>
      <GithubCard />
      <SlackCard />
      <AaCard />
    </Stack>
  );
}
