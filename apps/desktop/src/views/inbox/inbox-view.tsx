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

/** What the builder has typed or picked on one card. */
interface Draft {
  readonly id: InboxItemId;
  readonly choice: string | null;
  readonly note: string;
  readonly error: string | null;
}

export function InboxView() {
  const inbox = useInbox();
  const answer = useAnswerInbox();
  const queryClient = useQueryClient();
  const items = inbox.data ?? [];
  const [selectedId, setSelectedId] = useState<InboxItemId | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  // Selection follows the card, not its position: when an answered card leaves the list, the first card is next.
  const found = items.findIndex((item) => item.id === selectedId);
  const index = found === -1 ? 0 : found;
  const selected = items[index] ?? null;
  // The card shown by position is pinned at once, so a card that sorts in ahead later never takes over the
  // selection, a half-written note or the keys typed after it.
  if (selected && found === -1) setSelectedId(selected.id);
  // A draft applies to its own card only, so a card that sorts in ahead never inherits a choice or an error.
  const own = selected && draft?.id === selected.id ? draft : null;
  const choice = own?.choice ?? null;
  const note = own?.note ?? '';
  const error = own?.error ?? null;
  const effectiveChoice = selected ? (choice ?? recommended(selected)) : null;

  const select = (item: InboxItemDto): void => {
    setSelectedId(item.id);
    setDraft(null);
  };

  const patch = (id: InboxItemId, change: Partial<Omit<Draft, 'id'>>): void => {
    setDraft((current) => ({
      ...(current?.id === id ? current : { id, choice: null, note: '', error: null }),
      ...change,
    }));
  };

  const choose = (card: InboxItemDto, picked: string): void => {
    setSelectedId(card.id);
    patch(card.id, { choice: picked, error: null });
  };

  const submit = (): void => {
    if (!selected || answer.isPending) return;
    const id = selected.id;
    const picked = selected.options.length === 0 ? DISMISS_CHOICE : effectiveChoice;
    if (
      picked === null ||
      (selected.options.length > 0 && !selected.options.some((o) => o.label === picked))
    ) {
      patch(id, { error: 'Choose an option first (1–4).' });
      return;
    }
    const trimmed = note.trim();
    answer.mutate(
      { id, answer: trimmed === '' ? { choice: picked } : { choice: picked, note: trimmed } },
      {
        onSuccess: () => {
          setDraft((current) => (current?.id === id ? null : current));
        },
        onError: (failure) => {
          if (failure instanceof DaemonRequestError && failure.status === 409) {
            patch(id, { error: 'This card was already answered.' });
            void queryClient.invalidateQueries({ queryKey: queryKeys.inbox });
          } else {
            patch(id, { error: failure.message });
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
      if (selected && option) choose(selected, option.label);
    },
    onNote: () => {
      if (selected) setSelectedId(selected.id);
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
                  choose(item, value);
                }}
                onNote={(value) => {
                  setSelectedId(item.id);
                  patch(item.id, { note: value });
                }}
                onNoteFocus={() => {
                  setSelectedId(item.id);
                }}
                onSubmit={submit}
              />
            ))}
          </Stack>
        </>
      ) : null}
    </Stack>
  );
}
