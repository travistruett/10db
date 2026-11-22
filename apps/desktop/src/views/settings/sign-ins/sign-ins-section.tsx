import { Stack, Text } from '@mantine/core';
import { AaCard } from './aa-card';
import { GithubCard } from './github-card';
import { LinearCard } from './linear-card';
import { SlackCard } from './slack-card';

/**
 * Settings › Sign-ins: one card per outside service that isn't a model, each signed in once for every
 * project. Which project uses which is in the project's own Integrations.
 */
export function SignInsSection() {
  return (
    <Stack>
      <Text c="dimmed" size="sm">
        Outside services 10db uses that aren't models. Model access is in Accounts.
      </Text>
      <GithubCard />
      <SlackCard />
      <LinearCard />
      <AaCard />
    </Stack>
  );
}
