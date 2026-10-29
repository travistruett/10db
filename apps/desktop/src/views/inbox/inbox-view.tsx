import type { InboxItemDto, InboxItemId } from '@10db/contracts';
import { Alert, Group, Stack, Text, Title } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { DaemonRequestError } from '../../daemon/client';
import { queryKeys, useAnswerInbox, useInbox } from '../../daemon/queries';
import { InboxCard } from './inbox-card';
import { inboxRows, isDismissable, type InboxRow } from './inbox-rows';
import { InboxShortcuts } from './inbox-shortcuts';
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
  const rows = inboxRows(inbox.data ?? []);
  const [selectedId, setSelectedId] = useState<InboxItemId | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  // Selection follows the row, not its position: when an answered card leaves the list, the first row is next.
  const found = rows.findIndex((row) => row.key === selectedId);
  const index = found === -1 ? 0 : found;
  const selectedRow = rows[index] ?? null;
  const selected = selectedRow?.items[0] ?? null;
  // The row shown by position is pinned at once, so a card that sorts in ahead later never takes over the
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

  /** Dismisses every flag of `row`; one already closed elsewhere is skipped. */
  const dismiss = (row: InboxRow): void => {
    if (answer.isPending) return;
    void (async () => {
      for (const item of row.items) {
        try {
          await answer.mutateAsync({ id: item.id, answer: { choice: DISMISS_CHOICE } });
        } catch (failure) {
          if (failure instanceof DaemonRequestError && failure.status === 409) continue;
          patch(row.key, { error: failure instanceof Error ? failure.message : String(failure) });
          return;
        }
      }
      setDraft((current) => (current?.id === row.key ? null : current));
    })();
  };

  const submit = (): void => {
    if (!selectedRow || !selected || answer.isPending) return;
    if (isDismissable(selected)) {
      dismiss(selectedRow);
      return;
    }
    const id = selected.id;
    const picked = effectiveChoice;
    if (picked === null || !selected.options.some((o) => o.label === picked)) {
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
    count: rows.length,
    optionCount: selected?.options.length ?? 0,
    onMove: (delta) => {
      const next = rows[Math.min(rows.length - 1, Math.max(0, index + delta))]?.items[0];
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
    onHelp: () => {
      setHelpOpen(true);
    },
  });

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Inbox</Title>
        <InboxShortcuts
          opened={helpOpen}
          onOpen={() => {
            setHelpOpen(true);
          }}
          onClose={() => {
            setHelpOpen(false);
          }}
        />
      </Group>
      {inbox.isError ? (
        <Alert color="red" title="Couldn't load the inbox">
          {inbox.error.message}
        </Alert>
      ) : null}
      {inbox.isSuccess && rows.length === 0 ? (
        <Text c="dimmed">Nothing needs you right now.</Text>
      ) : null}
      {rows.length > 0 ? (
        <Stack gap="xs">
          {rows.map((row) => {
            const item = row.items[0];
            return (
              <InboxCard
                key={row.key}
                item={item}
                count={row.items.length}
                selected={item.id === selected?.id}
                choice={item.id === selected?.id ? effectiveChoice : null}
                note={item.id === selected?.id ? note : ''}
                error={item.id === selected?.id ? error : null}
                pending={answer.isPending && row.items.some((i) => i.id === answer.variables.id)}
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
                onDismiss={() => {
                  dismiss(row);
                }}
              />
            );
          })}
        </Stack>
      ) : null}
    </Stack>
  );
}
