import type { InboxItemDto, OutboundHit, PersonDto, StakeholderSendDto } from '@10db/contracts';
import { Alert, Button, Group, Kbd, Paper, Stack, Text, Textarea } from '@mantine/core';
import { useEffect, useState, type ReactNode } from 'react';
import { useSendInbox } from '../../daemon/people';
import { AskSomeone } from './ask-someone';
import { joinNames, routeLine } from './route-line';
import { sendFailureWords } from './send-failure';

/** What a held pattern is, in words a builder knows. */
const PATTERN_WORDS: Readonly<Record<string, string>> = {
  private_key: 'a private key',
  aws_access_key: 'an AWS access key',
  github_token: 'a GitHub token',
  slack_token: 'a Slack token',
  openai_key: 'an API key',
  anthropic_key: 'an API key',
  jwt: 'a login token',
  credential_assignment: 'a password or token',
  url: 'a link',
  code_block: 'a code block',
  file_path: 'a file path',
};

function patternWords(hit: OutboundHit): string {
  return PATTERN_WORDS[hit.pattern] ?? hit.pattern;
}

/** `*bold*` and `_italic_` as the preview draws them; everything else is plain text. */
function SlackText({ text }: { readonly text: string }) {
  const parts = text.split(/(\*[^*\n]+\*|_[^_\n]+_)/);
  return (
    <Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
      {parts.map((part, i) =>
        part.startsWith('*') && part.endsWith('*') && part.length > 2 ? (
          <b key={i}>{part.slice(1, -1)}</b>
        ) : part.startsWith('_') && part.endsWith('_') && part.length > 2 ? (
          <i key={i}>{part.slice(1, -1)}</i>
        ) : (
          part
        ),
      )}
    </Text>
  );
}

function sentTo(send: StakeholderSendDto, people: readonly PersonDto[]): PersonDto[] {
  return send.people.flatMap((p) => {
    const person = people.find((candidate) => candidate.id === p.personId);
    return p.recipient && person !== undefined ? [person] : [];
  });
}

function recipientNames(send: StakeholderSendDto): string[] {
  return send.people.filter((p) => p.recipient).map((p) => p.name);
}

/** Whether a keystroke is in a field, which keeps its own keys. */
function inField(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('input, textarea, select') !== null;
}

/**
 * A drafted (or failed) question as its recipients will read it. Sending takes ⌘↵, never a bare Enter:
 * a builder keying through the Inbox must not send a message unread.
 */
export function SlackPreview({
  item,
  send,
  people,
  header,
  onAnswerMyself,
}: {
  readonly item: InboxItemDto;
  readonly send: StakeholderSendDto;
  readonly people: readonly PersonDto[];
  readonly header: ReactNode;
  readonly onAnswerMyself: () => void;
}) {
  const sendInbox = useSendInbox();
  const [edited, setEdited] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const names = joinNames(recipientNames(send));
  const text = edited ?? send.text;
  const hold = send.hits.find((h) => h.severity === 'hold');
  const warnings = send.hits.filter((h) => h.severity === 'warn');
  const limitHeld = send.heldBy === 'limit';
  // A held message cannot go as it is: opening Edit changes nothing, and only different text is scanned again.
  const blocked = send.heldBy === 'scan' && (edited === null || edited === send.text);
  const limit = people.find((p) => p.id === send.people[0]?.personId)?.slack?.dailyLimit ?? null;
  // A failed card falls back to the builder; the line names who the message was for.
  const sentPeople = sentTo(send, people);
  const line = routeLine(item, people, sentPeople.length > 0 ? sentPeople : undefined);

  const submit = (overrideLimit: boolean): void => {
    if (sendInbox.isPending) return;
    sendInbox.mutate({
      id: item.id,
      input: {
        ...(edited !== null && edited !== send.text ? { text: edited } : {}),
        ...(overrideLimit ? { overrideLimit: true } : {}),
      },
    });
  };
  const sendNow = (): void => {
    if (!blocked && !limitHeld) submit(false);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || inField(event.target))
        return;
      event.preventDefault();
      sendNow();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  });

  return (
    <Paper withBorder p="md" shadow="xs" data-inbox-selected>
      <Stack gap="sm">
        {header}
        {/* Who gets it and why, with the card's one way to send it to someone else. */}
        <Group gap="xs">
          <Text size="sm" c="dimmed">
            {line.text}
          </Text>
          <AskSomeone item={item} people={people} label="Change" variant="subtle" />
        </Group>
        <Group justify="space-between">
          <Text fw={600} size="sm">
            {`${names} will get`}
          </Text>
          <Button
            size="xs"
            variant="subtle"
            onClick={() => {
              setEditing((e) => !e);
              if (!editing && edited === null) setEdited(send.text);
            }}
          >
            {editing ? 'Done' : 'Edit'}
          </Button>
        </Group>
        {editing ? (
          <Textarea
            aria-label="Message"
            autosize
            minRows={4}
            value={text}
            onChange={(event) => {
              setEdited(event.currentTarget.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                setEditing(false);
                sendNow();
              }
            }}
          />
        ) : (
          <Paper bg="var(--mantine-color-default-hover)" p="sm" radius="md">
            <SlackText text={text} />
          </Paper>
        )}
        {warnings.map((hit) => (
          <Text key={`${hit.pattern}:${String(hit.line)}`} size="xs" c="dimmed">
            {`Looks like ${patternWords(hit)} (line ${String(hit.line)}).`}
          </Text>
        ))}
        {send.state === 'failed' ? (
          <Alert color="red" variant="light">
            {sendFailureWords(send.error, names)}
          </Alert>
        ) : null}
        {send.heldBy === 'scan' && hold !== undefined ? (
          <Alert color="yellow" variant="light">
            {`This looks like ${patternWords(hold)} (line ${String(hold.line)}). Edit it before it goes to ${names}.`}
          </Alert>
        ) : null}
        {limitHeld ? (
          <Alert color="yellow" variant="light">
            {`${names} has had ${limit === null ? 'their limit of' : String(limit)} new questions today.`}
          </Alert>
        ) : null}
        {send.heldBy === 'first_send' ? (
          <Text size="sm" c="yellow">
            {`First message to ${names}: check it before it goes`}
          </Text>
        ) : null}
        {sendInbox.isError ? (
          <Alert color="red" variant="light">
            {sendInbox.error.message}
          </Alert>
        ) : null}
        <Group justify="space-between" wrap="nowrap" gap="md">
          <Text size="xs" c="dimmed">
            The task is parked until someone answers. Other work keeps running.
          </Text>
          <Group gap="sm" wrap="nowrap" style={{ flex: 'none' }}>
            <Button variant="default" onClick={onAnswerMyself}>
              Answer Myself
            </Button>
            {limitHeld ? (
              <Button
                loading={sendInbox.isPending}
                onClick={() => {
                  submit(true);
                }}
              >
                Send Anyway
              </Button>
            ) : (
              <Button
                disabled={blocked}
                loading={sendInbox.isPending}
                onClick={sendNow}
                rightSection={
                  <Kbd size="xs" aria-hidden>
                    ⌘↵
                  </Kbd>
                }
              >
                {`Send to ${names}`}
              </Button>
            )}
          </Group>
        </Group>
      </Stack>
    </Paper>
  );
}
