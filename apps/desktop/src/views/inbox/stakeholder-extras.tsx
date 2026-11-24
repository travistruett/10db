import { SendState, type AskedQuestion, type InboxItemDto, type PersonDto } from '@10db/contracts';
import { Alert, Anchor, Button, Group, Loader, Paper, Stack, Text, Textarea } from '@mantine/core';
import { useState, type ReactNode } from 'react';
import {
  useCompose,
  useKeepWaiting,
  useSlackStatus,
  useStakeholderReply,
  useStakeholderTimers,
} from '../../daemon/people';
import { useProjectIntegrations } from '../../daemon/sign-in-queries';
import { AskSomeone } from './ask-someone';
import { plainMessage } from './plain-message';
import { copyPeople, copyReason, joinNames, routeLine, StakeholderMode } from './route-line';
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
 * Copy button beside that line; the card's footer keeps Send Answer as its one primary.
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
  const slack = useProjectIntegrations(item.projectId).data?.slack;
  const why = joinNames(recipients.map((p) => `${p.name} ${copyReason(p, slack)}`));
  return (
    <Stack gap="xs">
      <Group justify="space-between" wrap="nowrap" gap="md">
        <Text size="sm">{`${why}. Copy this to them, then pick their answer below.`}</Text>
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
  off: 'Slack is off on this daemon, so replies can’t be read here. Answer this yourself or withdraw the question.',
  unreachable:
    "Slack can't be reached right now. Replies are read again when it is; you can answer this yourself meanwhile.",
};

const DECLINED_REASONS: Readonly<Record<NonNullable<AskedQuestion['declined']>, string>> = {
  not_answerable: "10db couldn't answer this from what it holds.",
  held: "10db's answer was held by the outbound check.",
  too_long: "10db's answer was too long to send.",
  unparseable: "10db couldn't put an answer together.",
  failed: "10db couldn't write an answer.",
  no_account: "The project's account is paused, so 10db couldn't answer.",
  provider: "10db can't answer on Codex yet.",
};

/** The question a stakeholder asked, with a reply box that says the builder's words in their thread. */
function AskedQuestionBox({
  item,
  asked,
  slackReady,
  actions,
}: {
  readonly item: InboxItemDto;
  readonly asked: AskedQuestion;
  readonly slackReady: boolean;
  readonly actions: ReactNode;
}) {
  const reply = useStakeholderReply();
  const [text, setText] = useState('');
  const first = asked.name.split(' ')[0] ?? asked.name;
  return (
    <Alert color="yellow" variant="light" title={`${asked.name} asked`}>
      <Stack gap="sm">
        <Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {`“${asked.text}”`}
        </Text>
        {asked.declined === null ? null : (
          <Text size="xs" c="dimmed">
            {DECLINED_REASONS[asked.declined]}
          </Text>
        )}
        <Textarea
          label={`Reply To ${first}`}
          autosize
          minRows={2}
          maxRows={8}
          value={text}
          disabled={!slackReady}
          onChange={(event) => {
            setText(event.currentTarget.value);
          }}
        />
        <Group gap="xs">
          <Button
            size="xs"
            disabled={text.trim() === '' || !slackReady}
            loading={reply.isPending}
            onClick={() => {
              reply.mutate(
                { id: item.id, text },
                {
                  onSuccess: () => {
                    setText('');
                  },
                },
              );
            }}
          >
            Send Reply
          </Button>
          {actions}
        </Group>
        <Text size="xs" c="dimmed">
          {`Or answer it yourself below; ${first} sees that you answered.`}
        </Text>
        {reply.isError ? (
          <Text size="xs" c="red">
            {reply.error.message}
          </Text>
        ) : null}
      </Stack>
    </Alert>
  );
}

/**
 * Why a question that was sent is back with the builder: nobody answered in time, the recipients
 * disagree, or Slack can't be read. Answer Myself is the card's own options below.
 */
export function SentNotice({ item }: { readonly item: InboxItemDto }) {
  const status = useSlackStatus();
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
  const workspace = status.data?.workspaces.find((w) => w.teamId === send.teamId);
  // The send's own workspace: another one being down says nothing about this question.
  const state =
    status.data === undefined ? undefined : status.data.off ? 'off' : (workspace?.state ?? 'none');
  const notice = state === undefined ? undefined : OUTAGE_NOTICES[state];
  const first = (names[0] ?? 'them').split(' ')[0] ?? 'them';
  const withdraw = (
    <Button
      size="xs"
      variant={send.asked === null ? 'default' : 'subtle'}
      onClick={() => {
        setTakingBack(true);
      }}
    >
      Withdraw Question
    </Button>
  );
  const actions = (
    <>
      {send.asked === null ? (
        <Button
          size="xs"
          variant="default"
          loading={keepWaiting.isPending}
          onClick={() => {
            keepWaiting.mutate(item.id);
          }}
        >
          {`Give ${first} More Time`}
        </Button>
      ) : null}
      {withdraw}
    </>
  );
  if (send.returnedAt !== null) {
    if (send.asked !== null)
      return (
        <Stack gap="xs">
          <AskedQuestionBox
            item={item}
            asked={send.asked}
            slackReady={notice === undefined}
            actions={actions}
          />
          {notice === undefined ? null : (
            <Alert color="yellow" variant="light">
              {notice}
            </Alert>
          )}
          <TakeBackModal
            item={item}
            opened={takingBack}
            onClose={() => {
              setTakingBack(false);
            }}
          />
        </Stack>
      );
    const title =
      send.returnedReason === 'disagreed'
        ? `${joinNames(names)} disagree`
        : `${joinNames(names)} ${names.length > 1 ? "haven't" : "hasn't"} answered in ${String(timers.data?.returnAfterHours ?? 8)} hours`;
    return (
      <Alert color="yellow" variant="light" title={title}>
        <Stack gap="sm">
          {quote}
          <Group gap="xs">{actions}</Group>
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
  return notice === undefined ? null : (
    <Alert color="yellow" variant="light">
      <Stack gap="xs">
        {notice}
        <Group>{withdraw}</Group>
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
