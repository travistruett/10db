import {
  commandParagraph,
  PermissionChoice,
  type InboxItemDto,
  type InboxOption,
} from '@10db/contracts';
import { Button, Divider, Group, Kbd, Paper, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import { IconShieldHalf } from '@tabler/icons-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { DaemonRequestError } from '../daemon/client';
import { useAnswerInbox } from '../daemon/queries';
import { CommandBlock } from '../views/inbox/command-block';
import { optionLabel } from '../views/inbox/permission-labels';
import { WAITING_CARD_ATTRIBUTE } from './escape';

// Every ask a conversation's session raises (a limit, a push, a command outside the sandbox) is this card,
// docked where the composer was: the question, its options, and a line to tell the agent what to do instead.

/** An option's button text: Allow Once and Deny are Yes and No, the rest are the Inbox's words. */
function buttonLabel(item: InboxItemDto, option: InboxOption): string {
  if (option.label === PermissionChoice.AllowOnce) return 'Yes';
  if (option.label === PermissionChoice.Deny) return 'No';
  return optionLabel(item, option);
}

function detailText(item: InboxItemDto, key: string): string | null {
  const value = item.detail?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * The body less what repeats the call shown in its own block: a body that is only the call, a raw call
 * leading the body, and the labelled `Command:` paragraph ending it. Each is cut whole, never split into
 * paragraphs, so no piece of a call with blank lines reappears beside 10db's words.
 */
function bodyWithoutCall(body: string, call: string | null): string {
  if (call === null) return body;
  if (body === call) return '';
  const lead = `${call}\n\n`;
  const after = body.startsWith(lead) ? body.slice(lead.length) : body;
  const labelled = `\n\n${commandParagraph(call)}`;
  return after.endsWith(labelled) ? after.slice(0, -labelled.length) : after;
}

export function AskCard({
  item,
  queued,
  onAnswered,
}: {
  readonly item: InboxItemDto;
  /** Other cards waiting behind this one. */
  readonly queued: number;
  readonly onAnswered?: () => void;
}) {
  const answer = useAnswerInbox();
  const field = useRef<HTMLInputElement>(null);
  // The card swaps in for the composer, so a key typed as it does lands here and not on a button.
  useEffect(() => {
    field.current?.focus();
  }, []);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const send = (choice: string, text: string): void => {
    if (answer.isPending) return;
    const trimmed = text.trim();
    answer.mutate(
      { id: item.id, answer: trimmed === '' ? { choice } : { choice, note: trimmed } },
      {
        ...(onAnswered === undefined ? {} : { onSuccess: onAnswered }),
        onError: (failure) => {
          setError(
            failure instanceof DaemonRequestError && failure.status === 409
              ? 'This card was already answered.'
              : failure.message,
          );
        },
      },
    );
  };
  const deny = (text: string): void => {
    send(PermissionChoice.Deny, text);
  };
  // Digits pick an option only while focus is on one of the card's buttons; the input keeps its own keys.
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      deny(note);
      return;
    }
    if (!(event.target instanceof HTMLButtonElement) || !/^[1-9]$/.test(event.key)) return;
    const option = item.options[Number(event.key) - 1];
    if (option === undefined) return;
    event.preventDefault();
    send(option.label, note);
  };
  if (answer.isSuccess) return null;
  const call = detailText(item, 'summary');
  // The command is in its own block, with its hidden characters shown; the body's own copy of it is left out.
  const rest = bodyWithoutCall(item.body, call);
  return (
    <Paper
      {...{ [WAITING_CARD_ATTRIBUTE]: true }}
      role="group"
      aria-label={item.title}
      withBorder
      radius="md"
      p="md"
      onKeyDown={onKeyDown}
      style={{ background: 'var(--tendb-color-card, var(--mantine-color-default))' }}
    >
      <Stack gap="sm">
        <Group gap="xs" wrap="nowrap" align="flex-start">
          <IconShieldHalf
            size={18}
            stroke={1.75}
            color="var(--mantine-color-orange-6)"
            aria-hidden
          />
          <Text fw={700} size="sm" style={{ flex: 1, overflowWrap: 'anywhere' }}>
            {item.title}
          </Text>
          {queued > 0 ? (
            <Text size="xs" c="dimmed">
              {String(queued)} more waiting
            </Text>
          ) : null}
        </Group>
        {call === null ? null : <CommandBlock command={call} />}
        {rest === '' ? null : (
          <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-line' }}>
            {rest}
          </Text>
        )}
        <Group gap="xs">
          {item.options.map((option, index) => (
            <Tooltip
              key={option.label}
              label={option.description}
              disabled={option.description === ''}
              multiline
              maw={280}
            >
              <Button
                size="xs"
                variant={option.label === PermissionChoice.AllowOnce ? 'filled' : 'default'}
                disabled={answer.isPending}
                rightSection={<Kbd size="xs">{String(index + 1)}</Kbd>}
                onClick={() => {
                  send(option.label, note);
                }}
              >
                {buttonLabel(item, option)}
              </Button>
            </Tooltip>
          ))}
        </Group>
        <Divider />
        <TextInput
          variant="unstyled"
          size="xs"
          aria-label="Tell Claude what to do instead"
          placeholder="Or tell Claude what to do instead…"
          ref={field}
          value={note}
          onChange={(event) => {
            setNote(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && note.trim() !== '') {
              event.preventDefault();
              deny(note);
            }
          }}
          rightSectionWidth={90}
          rightSection={
            <Text size="xs" c="dimmed" component="span">
              esc to say no
            </Text>
          }
        />
        {error === null ? null : (
          <Text size="xs" c="red" role="alert">
            {error}
          </Text>
        )}
      </Stack>
    </Paper>
  );
}
