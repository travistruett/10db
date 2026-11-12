import type { InboxItemDto, PersonDto } from '@10db/contracts';
import { Anchor, Button, Group, Loader, Paper, Text } from '@mantine/core';
import { useState } from 'react';
import { useCompose } from '../../daemon/people';
import { AskSomeone } from './ask-someone';
import { recipientsOf, routeLine, StakeholderMode } from './route-line';

/** The route line of a card that is not showing a draft: why this person, and Change. */
export function RouteLineRow({
  item,
  people,
  mode,
}: {
  readonly item: InboxItemDto;
  readonly people: readonly PersonDto[];
  readonly mode: StakeholderMode;
}) {
  if (mode === StakeholderMode.None || mode === StakeholderMode.Unrouted) return null;
  const line = routeLine(item, people);
  return (
    <Group gap="xs">
      {line.pending ? <Loader size="xs" /> : null}
      <Text size="sm" c="dimmed">
        {line.text}
      </Text>
      {mode === StakeholderMode.Copy ? (
        <AskSomeone item={item} people={people} label="Change" variant="subtle" />
      ) : null}
    </Group>
  );
}

/** The message a person not in Slack would get, to paste to them. */
export function ComposedMessage({
  item,
  people,
}: {
  readonly item: InboxItemDto;
  readonly people: readonly PersonDto[];
}) {
  const recipients = recipientsOf(item, people);
  const compose = useCompose(
    item.id,
    recipients.map((p) => p.id),
    recipients.length > 0,
  );
  if (!compose.isSuccess) return null;
  return (
    <Paper bg="var(--mantine-color-default-hover)" p="sm" radius="md">
      <Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {compose.data.text}
      </Text>
    </Paper>
  );
}

/** Copies the composed message for someone who is not in Slack; the card stays open for their answer. */
export function CopyForPeople({
  item,
  people,
}: {
  readonly item: InboxItemDto;
  readonly people: readonly PersonDto[];
}) {
  const recipients = recipientsOf(item, people);
  const compose = useCompose(
    item.id,
    recipients.map((p) => p.id),
    true,
  );
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="default"
      disabled={!compose.isSuccess}
      onClick={() => {
        if (compose.isSuccess)
          void navigator.clipboard.writeText(compose.data.text).then(() => {
            setCopied(true);
          });
      }}
    >
      {copied ? 'Copied' : `Copy for ${recipients.map((p) => p.name).join(' and ')}`}
    </Button>
  );
}

/** Ask Someone… in the footer of an unrouted question, with triage's suggestion beside it. */
export function AskSomeoneFooter({
  item,
  people,
}: {
  readonly item: InboxItemDto;
  readonly people: readonly PersonDto[];
}) {
  const suggestion = item.routeSuggestion;
  const suggested =
    suggestion === null ? undefined : people.find((p) => p.id === suggestion.personIds[0]);
  return (
    <>
      {suggestion !== null && suggested !== undefined ? (
        <Text size="sm" c="dimmed">
          {`Suggested: ${suggested.name} (${String(Math.round(suggestion.confidence * 100))}%)`}
        </Text>
      ) : null}
      <AskSomeone
        item={item}
        people={people}
        label="Ask Someone…"
        {...(suggested === undefined ? {} : { suggestedPersonId: suggested.id })}
      />
    </>
  );
}

export function SendInsteadLink({
  names,
  onClick,
}: {
  readonly names: string;
  readonly onClick: () => void;
}) {
  return (
    <Anchor component="button" type="button" size="sm" onClick={onClick}>
      {`Send to ${names} instead`}
    </Anchor>
  );
}
