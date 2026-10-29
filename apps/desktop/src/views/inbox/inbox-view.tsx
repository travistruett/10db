import { InboxKind, type InboxItemDto } from '@10db/contracts';
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

/** What the builder has typed or picked on one row's card. */
interface Draft {
  /** The row's key. */
  readonly id: string;
  readonly choice: string | null;
  readonly note: string;
  readonly error: string | null;
}

export function InboxView() {
  const inbox = useInbox();
  const answer = useAnswerInbox();
  const queryClient = useQueryClient();
  const rows = inboxRows(inbox.data ?? []);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  // A failed dismiss belongs to its row, which may not be the open one, so it never touches the draft.
  const [dismissFailure, setDismissFailure] = useState<{
    readonly key: string;
    readonly message: string;
  } | null>(null);
  // A check card's Send Back note, by card, so deselecting the card does not lose it.
  const [sendBackNotes, setSendBackNotes] = useState<Readonly<Record<string, string>>>({});
  const [helpOpen, setHelpOpen] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  // Selection follows the row, not its position: when an answered card leaves the list, the first row is next.
  const found = rows.findIndex((row) => row.key === selectedId);
  const index = found === -1 ? 0 : found;
  const selectedRow = rows[index] ?? null;
  const selected = selectedRow?.items[0] ?? null;
  // The row shown by position is pinned at once, so a card that sorts in ahead later never takes over the
  // selection, a half-written note or the keys typed after it.
  if (selectedRow && found === -1) setSelectedId(selectedRow.key);
  // A draft applies to its own card only, so a card that sorts in ahead never inherits a choice or an error.
  const own = selectedRow && draft?.id === selectedRow.key ? draft : null;
  const choice = own?.choice ?? null;
  const note = own?.note ?? '';
  const error = own?.error ?? null;
  const effectiveChoice = selected ? (choice ?? recommended(selected)) : null;

  const select = (row: InboxRow): void => {
    setSelectedId(row.key);
    setDraft(null);
  };

  const patch = (id: string, change: Partial<Omit<Draft, 'id'>>): void => {
    setDraft((current) => ({
      ...(current?.id === id ? current : { id, choice: null, note: '', error: null }),
      ...change,
    }));
  };

  const choose = (row: InboxRow, picked: string): void => {
    setSelectedId(row.key);
    patch(row.key, { choice: picked, error: null });
  };

  /**
   * Dismisses every flag of `row`. One already closed elsewhere is skipped, and the list refetched
   * so it leaves; any other failure stops there and is shown on the row.
   */
  const dismiss = (row: InboxRow): void => {
    if (answer.isPending) return;
    setDismissFailure(null);
    void (async () => {
      let stale = false;
      for (const item of row.items) {
        try {
          await answer.mutateAsync({ id: item.id, answer: { choice: DISMISS_CHOICE } });
        } catch (failure) {
          if (failure instanceof DaemonRequestError && failure.status === 409) {
            stale = true;
            continue;
          }
          setDismissFailure({
            key: row.key,
            message: failure instanceof Error ? failure.message : String(failure),
          });
          break;
        }
      }
      if (stale) await queryClient.invalidateQueries({ queryKey: queryKeys.inbox });
    })();
  };

  const submit = (): void => {
    // A check card is answered by its own buttons, never by a key.
    if (!selectedRow || !selected || selected.kind === InboxKind.Check || answer.isPending) return;
    if (isDismissable(selected)) {
      dismiss(selectedRow);
      return;
    }
    const id = selected.id;
    const key = selectedRow.key;
    const picked = effectiveChoice;
    if (picked === null || !selected.options.some((o) => o.label === picked)) {
      patch(key, { error: 'Choose an option first (1–4).' });
      return;
    }
    const trimmed = note.trim();
    answer.mutate(
      { id, answer: trimmed === '' ? { choice: picked } : { choice: picked, note: trimmed } },
      {
        onSuccess: () => {
          setDraft((current) => (current?.id === key ? null : current));
        },
        onError: (failure) => {
          if (failure instanceof DaemonRequestError && failure.status === 409) {
            patch(key, { error: 'This card was already answered.' });
            void queryClient.invalidateQueries({ queryKey: queryKeys.inbox });
          } else {
            patch(key, { error: failure.message });
          }
        },
      },
    );
  };

  useInboxKeys({
    count: rows.length,
    optionCount: selected?.kind === InboxKind.Check ? 0 : (selected?.options.length ?? 0),
    onMove: (delta) => {
      const next = rows[Math.min(rows.length - 1, Math.max(0, index + delta))];
      if (!next || next.key === selectedRow?.key) return false;
      select(next);
      return true;
    },
    onChoose: (i) => {
      const option = selected?.options[i];
      if (selectedRow && option) choose(selectedRow, option.label);
    },
    onNote: () => {
      if (selectedRow) setSelectedId(selectedRow.key);
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
            const open = row.key === selectedRow?.key;
            const failed = dismissFailure?.key === row.key ? dismissFailure.message : null;
            return (
              <InboxCard
                key={row.key}
                item={row.items[0]}
                count={row.items.length}
                selected={open}
                choice={open ? effectiveChoice : null}
                note={open ? note : ''}
                error={open ? (error ?? failed) : failed}
                pending={answer.isPending && row.items.some((i) => i.id === answer.variables.id)}
                noteRef={noteRef}
                onSelect={() => {
                  select(row);
                }}
                onChoose={(value) => {
                  choose(row, value);
                }}
                onNote={(value) => {
                  setSelectedId(row.key);
                  patch(row.key, { note: value });
                }}
                sendBackNote={sendBackNotes[row.items[0].id] ?? ''}
                onSendBackNote={(value) => {
                  setSendBackNotes((current) => ({ ...current, [row.items[0].id]: value }));
                }}
                onNoteFocus={() => {
                  setSelectedId(row.key);
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
