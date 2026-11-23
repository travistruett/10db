import { Group, Stack, Text, Title } from '@mantine/core';
import type { ReactNode } from 'react';
import { HelpHint, HelpText } from './help-hint';
import { AaCard } from './sign-ins/aa-card';
import { GithubCard } from './sign-ins/github-card';
import { LinearCard } from './sign-ins/linear-card';
import { SlackCard } from './sign-ins/slack-card';

/** A group of cards: a heading with at most one dim line, then the cards. */
function CardGroup({
  title,
  description,
  help,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly help?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <Stack gap="sm">
      <Stack gap={2}>
        <Group gap={4} wrap="nowrap">
          <Title order={5}>{title}</Title>
          {help ? <HelpHint label={title}>{help}</HelpHint> : null}
        </Group>
        <Text size="xs" c="dimmed">
          {description}
        </Text>
      </Stack>
      {children}
    </Stack>
  );
}

/**
 * Settings › Integrations: one card per outside service that isn't a model. A service is signed in once for
 * every project; Slack and Linear then list the projects, each with its own switch. Model access is in
 * Accounts.
 */
export function IntegrationsSection() {
  return (
    <Stack gap="xl">
      <Text c="dimmed" size="sm">
        Outside services 10db uses that aren't models. Model access is in Accounts.
      </Text>
      <CardGroup title="Connected By 10db" description="Signed in once, for every project.">
        <GithubCard />
        <SlackCard />
        <AaCard />
      </CardGroup>
      <CardGroup
        title="Through Your Agent"
        description="Uses your agent's own sign-in; 10db stores no login."
        help={
          <HelpText>
            These turn on when the project's agent is signed in to the service through its MCP
            servers or connectors. Without one, what needs it waits or stays in your Inbox.
          </HelpText>
        }
      >
        <LinearCard />
      </CardGroup>
    </Stack>
  );
}
