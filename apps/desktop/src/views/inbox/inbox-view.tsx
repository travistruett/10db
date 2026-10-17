import type { InboxItemDto, InboxItemId } from '@10db/contracts';
import { Alert, Stack, Text, Title } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { DaemonRequestError } from '../../daemon/client';
import { queryKeys, useAnswerInbox, useInbox } from '../../daemon/queries';
import { InboxCard } from './inbox-card';
import { useInboxKeys } from './use-inbox-keys';

/** Flag cards have no options; the daemon accepts any choice and closes them. */
export const DISMISS_CHOICE = 'dismissed';

/** A recommendation preselects only when it names one of the options. */
function recommended(item: InboxItemDto): string | null {
  return item.options.some((o) => o.label === item.recommendation) ? item.recommendation : null;
}

export function InboxView() {
  const inbox = useInbox();
  const answer = useAnswerInbox();
  const queryClient = useQueryClient();
  const items = inbox.data ?? [];
  const [selectedId, setSelectedId] = useState<InboxItemId | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  // Selection follows the card, not its position: when an answered card leaves the list, the first card is next.
  const found = items.findIndex((item) => item.id === selectedId);
  const index = found === -1 ? 0 : found;
  const selected = items[index] ?? null;
  const effectiveChoice = selected ? (choice ?? recommended(selected)) : null;

  const select = (item: InboxItemDto): void => {
    setSelectedId(item.id);
    setChoice(null);
    setNote('');
    setError(null);
  };

  const submit = (): void => {
    if (!selected || answer.isPending) return;
    const picked = selected.options.length === 0 ? DISMISS_CHOICE : effectiveChoice;
    if (picked === null) {
      setError('Choose an option first (1–4).');
      return;
    }
    const trimmed = note.trim();
    answer.mutate(
      {
        id: selected.id,
        answer: trimmed === '' ? { choice: picked } : { choice: picked, note: trimmed },
      },
      {
        onSuccess: () => {
          setChoice(null);
          setNote('');
          setError(null);
        },
        onError: (failure) => {
          if (failure instanceof DaemonRequestError && failure.status === 409) {
            setError('This card was already answered.');
            void queryClient.invalidateQueries({ queryKey: queryKeys.inbox });
          } else {
            setError(failure.message);
          }
        },
      },
    );
  };

  useInboxKeys({
    count: items.length,
    optionCount: selected?.options.length ?? 0,
    onMove: (delta) => {
      const next = items[Math.min(items.length - 1, Math.max(0, index + delta))];
      if (next && next.id !== selected?.id) select(next);
    },
    onChoose: (i) => {
      const option = selected?.options[i];
      if (option) setChoice(option.label);
    },
    onNote: () => {
      noteRef.current?.focus();
    },
    onSubmit: submit,
  });

  return (
    <Stack>
      <Title order={2}>Inbox</Title>
      {inbox.isError ? (
        <Alert color="red" title="Couldn't load the inbox">
          {inbox.error.message}
        </Alert>
      ) : null}
      {inbox.isSuccess && items.length === 0 ? (
        <Text c="dimmed">Nothing needs you right now.</Text>
      ) : null}
      {items.length > 0 ? (
        <>
          <Text size="xs" c="dimmed">
            j/k to move · 1–4 to choose · n to add a note · Enter to send
          </Text>
          <Stack gap="xs">
            {items.map((item) => (
              <InboxCard
                key={item.id}
                item={item}
                selected={item.id === selected?.id}
                choice={item.id === selected?.id ? effectiveChoice : null}
                note={item.id === selected?.id ? note : ''}
                error={item.id === selected?.id ? error : null}
                pending={answer.isPending && answer.variables.id === item.id}
                noteRef={noteRef}
                onSelect={() => {
                  select(item);
                }}
                onChoose={(value) => {
                  setChoice(value);
                  setError(null);
                }}
                onNote={setNote}
                onSubmit={submit}
              />
            ))}
          </Stack>
        </>
      ) : null}
    </Stack>
  );
}
