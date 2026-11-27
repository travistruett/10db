import { Stack } from '@mantine/core';
import type { ReactNode } from 'react';
import { HelpText } from './help-hint';
import { AaCard } from './sign-ins/aa-card';
import { GithubCard } from './sign-ins/github-card';
import { FigmaCard } from './sign-ins/figma-card';
import { LinearCard } from './sign-ins/linear-card';
import { SlackCard } from './sign-ins/slack-card';
import { SectionHeading } from './section-heading';

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
      <SectionHeading title={title} line={description} {...(help ? { help } : {})} />
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
      <CardGroup title="Used by 10db" description="10db signs in once and uses these itself.">
        <GithubCard />
        <SlackCard />
        <AaCard />
      </CardGroup>
      <CardGroup
        title="Agent Connectors"
        description="Each agent account signs in; tasks use these as MCP servers."
        help={
          <HelpText>
            These turn on when the project's agent is signed in to the service through its MCP
            servers or connectors. Without one, what needs it waits or stays in your Inbox.
          </HelpText>
        }
      >
        <LinearCard />
        <FigmaCard />
      </CardGroup>
    </Stack>
  );
}
