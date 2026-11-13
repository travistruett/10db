import { SendState, type InboxItemDto, type PersonDto } from '@10db/contracts';
import { Alert, Anchor, Button, Group, Loader, Paper, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import {
  useCompose,
  useKeepWaiting,
  useSlackConnection,
  useStakeholderTimers,
} from '../../daemon/people';
import { AskSomeone } from './ask-someone';
import { plainMessage } from './plain-message';
import { copyPeople, joinNames, routeLine, StakeholderMode } from './route-line';
import { TakeBackModal } from './take-back-modal';

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
  const line = routeLine(
    item,
    people,
    mode === StakeholderMode.Copy ? copyPeople(item, people) : undefined,
  );
  return (
    <Group gap="xs">
      {line.pending ? <Loader size="xs" /> : null}
      <Text size="sm" c="dimmed">
        {mode === StakeholderMode.Copy ? `${line.text} · chosen by you` : line.text}
      </Text>
      {mode === StakeholderMode.Copy ? (
        <AskSomeone item={item} people={people} label="Change" variant="subtle" />
      ) : null}
    </Group>
  );
}

/**
 * The message for people not in Slack, under a line that says what the builder does with it, and the
 * Copy button beside that line; the card's footer keeps Send answer as its one primary.
 */
export function ComposedMessage({
  item,
  recipients,
}: {
  readonly item: InboxItemDto;
  readonly recipients: readonly PersonDto[];
}) {
  const compose = useCompose(
    item.id,
    recipients.map((p) => p.id),
    recipients.length > 0,
  );
  const names = joinNames(recipients.map((p) => p.name));
  return (
    <Stack gap="xs">
      <Group justify="space-between" wrap="nowrap" gap="md">
        <Text size="sm">
          {`${names} ${recipients.length > 1 ? "aren't" : "isn't"} on Slack. Copy this to them, then pick their answer below.`}
        </Text>
        <CopyForPeople item={item} recipients={recipients} />
      </Group>
      {compose.isSuccess ? (
        <Paper bg="var(--mantine-color-default-hover)" p="sm" radius="md">
          <Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {plainMessage(compose.data.text)}
          </Text>
        </Paper>
      ) : null}
    </Stack>
  );
}

/** Copies the composed message for someone who is not in Slack; the card stays open for their answer. */
function CopyForPeople({
  item,
  recipients,
}: {
  readonly item: InboxItemDto;
  readonly recipients: readonly PersonDto[];
}) {
  const compose = useCompose(
    item.id,
    recipients.map((p) => p.id),
    true,
  );
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="xs"
      variant="default"
      style={{ flex: 'none' }}
      disabled={!compose.isSuccess}
      onClick={() => {
        if (compose.isSuccess)
          void navigator.clipboard.writeText(plainMessage(compose.data.text)).then(() => {
            setCopied(true);
          });
      }}
    >
      {copied ? 'Copied' : `Copy for ${recipients.map((p) => p.name).join(' and ')}`}
    </Button>
  );
}

/** Ask Someone in the footer of an unrouted question, with triage's suggestion beside it. */
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
        label="Ask Someone"

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

const OUTAGE_NOTICES: Readonly<Record<string, string>> = {
  refused:
    "Slack refused 10db's token, so replies can't be read. Reconnect it in Settings › Integrations, or answer this yourself.",
  none: "Slack's token was removed, so replies can't be read. Add it again in Settings › Integrations, or answer this yourself.",
  off: 'Slack is off on this daemon, so replies can’t be read here. Answer this yourself or take it back.',
  unreachable:
    "Slack can't be reached right now. Replies are read again when it is; you can answer this yourself meanwhile.",
};

/**
 * Why a question that was sent is back with the builder: nobody answered in time, the recipients
 * disagree, or Slack can't be read. Answer Myself is the card's own options below.
 */
export function SentNotice({ item }: { readonly item: InboxItemDto }) {
  const connection = useSlackConnection();
  const timers = useStakeholderTimers();
  const keepWaiting = useKeepWaiting();
  const [takingBack, setTakingBack] = useState(false);
  const send = item.send;
  if (send?.state !== SendState.Sent) return null;
  const names = send.people.filter((p) => p.recipient).map((p) => p.name);
  const quote = (
    <Stack gap={2}>
      {send.conversation.map((message) => (
        <Text key={message.ts} size="sm" style={{ whiteSpace: 'pre-wrap' }}>
          {`${message.name}: ${message.text}`}
        </Text>
      ))}
    </Stack>
  );
  if (send.returnedAt !== null) {
    const title =
      send.returnedReason === 'disagreed'
        ? `${joinNames(names)} disagree`
        : `${joinNames(names)} hasn't answered in ${String(timers.data?.returnAfterHours ?? 8)} hours`;
    return (
      <Alert color="yellow" variant="light" title={title}>
        <Stack gap="sm">
          {quote}
          <Group gap="xs">
            <Button
              size="xs"
              variant="default"
              loading={keepWaiting.isPending}
              onClick={() => {
                keepWaiting.mutate(item.id);
              }}
            >
              Keep Waiting
            </Button>
            <Button
              size="xs"
              variant="default"
              onClick={() => {
                setTakingBack(true);
              }}
            >
              Take Back
            </Button>
          </Group>
          {keepWaiting.isError ? (
            <Text size="xs" c="red">
              {keepWaiting.error.message}
            </Text>
          ) : null}
        </Stack>
        <TakeBackModal
          item={item}
          opened={takingBack}
          onClose={() => {
            setTakingBack(false);
          }}
        />
      </Alert>
    );
  }
  const state = connection.data?.state;
  const notice = state === undefined ? undefined : OUTAGE_NOTICES[state];
  return notice === undefined ? null : (
    <Alert color="yellow" variant="light">
      {notice}
    </Alert>
  );
}
