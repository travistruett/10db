import { InboxKind, type DecisionRecording, type ProjectId } from '@10db/contracts';
import { Alert, Group, SegmentedControl, Stack, Text, Title } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { DaemonRequestError } from '../../daemon/client';
import { usePeople } from '../../daemon/people';
import {
  queryKeys,
  useAnswerInbox,
  useInbox,
  useProjects,
  useSystemCheck,
} from '../../daemon/queries';
import { ProjectFilter } from '../../shell/project-filter';
import { inProject } from './in-project';
import { cardAnswer, recommended } from './card-answer';
import { InboxCard } from './inbox-card';
import { inboxRows, isDismissable, type InboxRow } from './inbox-rows';
import { InboxShortcuts } from './inbox-shortcuts';
import { PassReadyRow, useOpenPassWorkbench } from './pass-ready-row';
import { defaultRecording } from './record-decision';
import { ResolvedInbox } from './resolved-inbox';
import { SystemCardList } from './system-card-list';
import { systemCards, type SystemCard } from './system-cards';
import { stakeholderMode, StakeholderMode } from './route-line';
import { useInboxKeys } from './use-inbox-keys';

/** Flag cards have no options; the daemon accepts any choice and closes them. */
export const DISMISS_CHOICE = 'dismissed';

/** What the builder has typed or picked on one row's card. */
interface Draft {
  /** The row's key. */
  readonly id: string;
  readonly choice: string | null;
  readonly note: string;
  /** How a question's answer is recorded as a decision; absent until the builder changes the default. */
  readonly record?: DecisionRecording | null;
  readonly error: string | null;
}

type Tab = 'open' | 'resolved';

/** The Inbox: the cards that wait on the builder, and a view of the ones already closed. */
export function InboxView() {
  const [tab, setTab] = useState<Tab>('open');
  const [helpOpen, setHelpOpen] = useState(false);
  const inbox = useInbox();
  const projects = useProjects();
  const { project } = useSearch({ from: '/inbox' });
  const navigate = useNavigate({ from: '/inbox' });
  // 10db's own cards are the app's, not a project's, so they show under every filter.
  const cards = systemCards(useSystemCheck().data);
  // The header is drawn here once, the same for both views, so switching moves nothing in it.
  const openCount = inbox.isSuccess
    ? inboxRows(inProject(inbox.data, project)).length + cards.length
    : null;
  // Each view is its own component, so the open view's keys are only live while it is shown.
  return (
    <Stack>
      <Group justify="space-between">
        <Group gap="md">
          <Title order={2}>Inbox</Title>
          <SegmentedControl
            aria-label="Inbox view"
            value={tab}
            onChange={(value) => {
              setTab(value === 'resolved' ? 'resolved' : 'open');
            }}
            data={[
              { value: 'open', label: openCount === null ? 'Open' : `Open ${String(openCount)}` },
              { value: 'resolved', label: 'Resolved' },
            ]}
          />
        </Group>
        <Group gap="sm">
          <ProjectFilter
            projects={projects.data ?? []}
            value={project ?? null}
            onChange={(next) => {
              void navigate({ search: next === null ? {} : { project: next } });
            }}
          />
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
      </Group>
      {tab === 'open' ? (
        <OpenInbox
          project={project}
          systemCards={cards}
          onHelp={() => {
            setHelpOpen(true);
          }}
        />
      ) : (
        <ResolvedInbox project={project} />
      )}
    </Stack>
  );
}

function OpenInbox({
  project,
  systemCards: ownCards,
  onHelp,
}: {
  readonly project: ProjectId | undefined;
  readonly systemCards: readonly SystemCard[];
  readonly onHelp: () => void;
}) {
  const inbox = useInbox();
  const answer = useAnswerInbox();
  const queryClient = useQueryClient();
  const openWorkbench = useOpenPassWorkbench();
  const rows = inboxRows(inProject(inbox.data ?? [], project));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  // A failed dismiss belongs to its row, which may not be the open one, so it never touches the draft.
  const [dismissFailure, setDismissFailure] = useState<{
    readonly key: string;
    readonly message: string;
  } | null>(null);
  // A check card's Send Back note, by card, so deselecting the card does not lose it.
  const [sendBackNotes, setSendBackNotes] = useState<Readonly<Record<string, string>>>({});
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const people = usePeople().data ?? [];
  // Cards the builder chose to answer themselves instead of sending the drafted message.
  const [myself, setMyself] = useState<ReadonlySet<string>>(new Set());

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
  // Until the builder changes it, a question is recorded as the daemon would record it by default.
  const recording =
    own?.record !== undefined ? own.record : selected ? defaultRecording(selected) : null;

  // A drafted message is sent with ⌘↵ only: its options are not live, and a bare Enter sends nothing.
  const previewing =
    selected !== null &&
    !myself.has(selected.id) &&
    [StakeholderMode.Draft, StakeholderMode.Failed].some(
      (m) => m === stakeholderMode(selected, people),
    );

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
    // A pass's Ready pages open the Workbench (spec §4.1, §4.6); each is signed off by its own button.
    if (selectedRow?.passId != null && selected) {
      openWorkbench(selected.projectId);
      return;
    }
    // A check card is answered by its own buttons, never by a key.
    if (!selectedRow || !selected || selected.kind === InboxKind.Check || answer.isPending) return;
    if (previewing) return;
    if (isDismissable(selected)) {
      dismiss(selectedRow);
      return;
    }
    const id = selected.id;
    const key = selectedRow.key;
    const picked = effectiveChoice;
    if (picked === null || !selected.options.some((o) => o.label === picked)) {
      patch(key, { error: 'Choose an option first (1–5).' });
      return;
    }
    const body = cardAnswer(selected, picked, note, recording);
    answer.mutate(
      { id, answer: body },
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
    optionCount:
      selected?.kind === InboxKind.Check || previewing ? 0 : (selected?.options.length ?? 0),
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
    onHelp,
  });

  return (
    <Stack>
      {inbox.isError ? (
        <Alert color="red" title="Couldn't load the inbox">
          {inbox.error.message}
        </Alert>
      ) : null}
      <SystemCardList cards={ownCards} />
      {inbox.isSuccess && rows.length === 0 && ownCards.length === 0 ? (
        <Text c="dimmed">Nothing needs you right now.</Text>
      ) : null}
      {rows.length > 0 ? (
        <Stack gap="xs">
          {rows.map((row) => {
            const open = row.key === selectedRow?.key;
            const failed = dismissFailure?.key === row.key ? dismissFailure.message : null;
            if (row.passId !== null)
              return (
                <PassReadyRow
                  key={row.key}
                  items={row.items}
                  selected={open}
                  onSelect={() => {
                    select(row);
                  }}
                />
              );
            return (
              <InboxCard
                key={row.key}
                item={row.items[0]}
                count={row.items.length}
                selected={open}
                choice={open ? effectiveChoice : null}
                note={open ? note : ''}
                recording={open ? recording : null}
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
                onRecord={(next) => {
                  setSelectedId(row.key);
                  patch(row.key, { record: next });
                }}
                sendBackNote={sendBackNotes[row.items[0].id] ?? ''}
                onSendBackNote={(value) => {
                  setSendBackNotes((current) => ({ ...current, [row.items[0].id]: value }));
                }}
                onNoteFocus={() => {
                  setSelectedId(row.key);
                }}
                onSubmit={submit}
                answeringMyself={myself.has(row.items[0].id)}
                onAnswerMyself={(value) => {
                  setMyself((current) => {
                    const next = new Set(current);
                    if (value) next.add(row.items[0].id);
                    else next.delete(row.items[0].id);
                    return next;
                  });
                }}
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
