import { Badge, Button, Group, Paper, Stack, Text } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useRecheckSystem } from '../../daemon/queries';
import { SettingsSectionKey } from '../settings/sections';
import { SystemCardKind, type SystemCard } from './system-cards';
import { KEYS_IGNORE_ATTRIBUTE } from './use-inbox-keys';

/** What a 10db card says: what is wrong, and what the builder does about it. */
function cardText(card: SystemCard): { readonly title: string; readonly body: string } {
  switch (card.kind) {
    case SystemCardKind.MissingTool:
      return {
        title: `${card.tool} was not found where 10db looks for it`,
        body: '10db runs it only from /opt/homebrew/bin, /usr/local/bin or /usr/bin, never from your PATH, where a lane could put one. Install it there, then restart 10db. Sessions can’t start until it is found.',
      };
    case SystemCardKind.RefusedCopy:
      return {
        title: `${card.agent.label} ${card.agent.pinned} can't be used`,
        body: `${card.agent.problem ?? 'Its copy failed the check.'} No session runs on it. Fetch It Again removes this copy and downloads a fresh one, checked against the same recorded checksum.`,
      };
    case SystemCardKind.LoginShell:
      return {
        title: "10db couldn't read your login shell's environment",
        body: card.warning,
      };
    case SystemCardKind.BenchmarkKey:
      return {
        title: card.message,
        body: 'Replace the key in Settings › Integrations. The next sync reads it. Routing uses the last good scores until a sync succeeds.',
      };
    case SystemCardKind.SlackRefused:
      return {
        title: "Slack refused 10db's token",
        body: 'Reconnect it in Settings › Integrations. Questions already sent stay in your Open tab until it works again, so you can answer them yourself.',
      };
  }
}

/** The Integrations card a connection card is fixed on, or null when the card has no such place. */
function integrationsFocus(card: SystemCard): string | null {
  switch (card.kind) {
    case SystemCardKind.BenchmarkKey:
      return 'artificial-analysis';
    case SystemCardKind.SlackRefused:
      return 'slack';
    case SystemCardKind.MissingTool:
    case SystemCardKind.RefusedCopy:
    case SystemCardKind.LoginShell:
      return null;
  }
}

function SystemCardView({ card }: { readonly card: SystemCard }) {
  const recheck = useRecheckSystem();
  const { title, body } = cardText(card);
  let action: ReactNode = null;
  if (card.kind === SystemCardKind.RefusedCopy)
    action = (
      <Button
        size="xs"
        variant="default"
        loading={recheck.isPending}
        onClick={() => {
          recheck.mutate();
        }}
      >
        Fetch It Again
      </Button>
    );
  const integrations = integrationsFocus(card);
  if (integrations)
    action = (
      <Button
        size="xs"
        variant="default"
        renderRoot={(props) => (
          <Link
            {...props}
            to="/settings/$section"
            params={{ section: SettingsSectionKey.Integrations }}
            search={{ focus: integrations }}
          />
        )}
      >
        Open Integrations
      </Button>
    );
  return (
    <Paper withBorder p="md" shadow="xs">
      <Stack gap="sm" align="flex-start">
        <Group gap="sm" wrap="nowrap">
          {/* Every card waits on the builder: yellow, as a lane's cards are. */}
          <Badge size="sm" variant="light" color="yellow" style={{ flexShrink: 0 }}>
            10db
          </Badge>
          <Text fw={600} style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
            {title}
          </Text>
        </Group>
        <Text size="sm">{body}</Text>
        {action}
      </Stack>
    </Paper>
  );
}

/**
 * 10db's own cards, above the lanes' cards: what stops or degrades work until the builder fixes it. They
 * come from the system check and leave once it no longer finds them, so nothing answers or resolves them.
 */
export function SystemCardList({ cards }: { readonly cards: readonly SystemCard[] }) {
  if (cards.length === 0) return null;
  return (
    <Stack gap="xs" {...{ [KEYS_IGNORE_ATTRIBUTE]: true }}>
      {cards.map((card) => (
        <SystemCardView key={card.key} card={card} />
      ))}
    </Stack>
  );
}
