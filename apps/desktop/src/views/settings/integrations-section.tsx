import { Stack, Text } from '@mantine/core';
import { AaCard } from './sign-ins/aa-card';
import { GithubCard } from './sign-ins/github-card';
import { LinearCard } from './sign-ins/linear-card';
import { SlackCard } from './sign-ins/slack-card';

/**
 * Settings › Integrations: one card per outside service that isn't a model. A service is signed in once for
 * every project; Slack and Linear then list the projects, each with its own switch. Model access is in
 * Accounts.
 */
export function IntegrationsSection() {
  return (
    <Stack>
      <Text c="dimmed" size="sm">
        Outside services 10db uses that aren't models. Without one, what needs it waits or stays in
        your Inbox. Model access is in Accounts.
      </Text>
      <Text fw={600} mt="xs">
        Connected By 10db
      </Text>
      <GithubCard />
      <SlackCard />
      <AaCard />
      <Text fw={600} mt="xs">
        Through Your Agent
      </Text>
      <Text c="dimmed" size="sm">
        10db stores no login for these. They turn on when the project's agent is signed in to the
        service through its MCP servers or connectors.
      </Text>
      <LinearCard />
    </Stack>
  );
}
