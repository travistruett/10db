import { Stack, Text } from '@mantine/core';
import { AaCard } from './sign-ins/aa-card';
import { GithubCard } from './sign-ins/github-card';
import { LinearCard } from './sign-ins/linear-card';
import { SlackCard } from './sign-ins/slack-card';

/**
 * Settings › Integrations: one card per outside service that isn't a model. A service is signed in once for
 * every project; Slack and Linear then list the projects, each with its own switch or team. Model access is in
 * Accounts.
 */
export function IntegrationsSection() {
  return (
    <Stack>
      <Text c="dimmed" size="sm">
        Outside services 10db uses that aren't models. Without one, what needs it waits or stays in
        your Inbox. Model access is in Accounts.
      </Text>
      <GithubCard />
      <SlackCard />
      <LinearCard />
      <AaCard />
    </Stack>
  );
}
