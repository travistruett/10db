import {
  InboxKind,
  InboxListState,
  isDismissable,
  type DecisionRecording,
  type InboxItemDto,
  type InboxItemId,
} from '@10db/contracts';
import { Alert } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DaemonRequestError } from '../../daemon/client';
import { dropCard, refreshCard as refreshCardEverywhere } from '../../daemon/inbox-live';
import { useInboxRows, type InboxRow } from '../../daemon/inbox-queries';
import { usePeople, useSlackConnection } from '../../daemon/people';
import { useDaemon } from '../../daemon/provider';
import { queryKeys, useAnswerInbox, useSystemCheck } from '../../daemon/queries';
import { useFrameSlots } from '../../shell/frame-slots';
import { useNow } from '../../shell/relative';
import { cardAnswer, recommended } from './card-answer';
import { InboxRowList } from './inbox-row-list';
import { inboxRowOf, InboxRowItem, OpenRowKind, systemRow, type OpenRow } from './inbox-row-item';
import {
  inboxList,
  inboxStateMemory,
  narrowed,
  rememberScroll,
  rememberSelected,
  type InboxSearch,
} from './inbox-search';
import { nextSelection } from './inbox-selection';
import { OpenContent } from './open-content';
import { useOpenPassWorkbench } from './pass-ready-row';
import { usePrefetchNextRow } from './prefetch-next-row';
import { defaultRecording } from './record-decision';
import { stakeholderMode, StakeholderMode } from './route-line';
import { systemCards } from './system-cards';
import { useInboxKeys } from './use-inbox-keys';

/** Flag cards have no options; the daemon accepts any choice and closes them. */
export const DISMISS_CHOICE = 'dismissed';

const ANSWERED_ELSEWHERE = 'This card was already answered.';

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

/** A page of the list is on its way for a move past the loaded end: how many rows there were, and the last failure. */
interface AwaitedPage {
  readonly length: number;
  readonly failure: Error | null;
}

/**
 * Open: the cards that wait on the builder. The rows go into the panel's list (`listHost`) and the selected
 * row's card is the content, with its draft, its keys and its answer.
 */
export function OpenInbox({
  search,
  listHost,
  onClearFilters,
  onHelp,
}: {
  readonly search: InboxSearch;
  /** The element in the panel the list is drawn into; null until the frame has drawn the panel. */
  readonly listHost: HTMLElement | null;
  readonly onClearFilters: () => void;
  readonly onHelp: () => void;
}) {
  const now = useNow();
  const open = useInboxRows(inboxList(search, new Date(now)));
  const connection = useSlackConnection();
  const systemChecks = systemCards(useSystemCheck().data, connection.data);
  // 10db's own cards are not in the daemon's list, so a search or a kind would otherwise leave them showing.
  const ownCards = search.q === undefined && search.kind === undefined ? systemChecks : [];
  const answer = useAnswerInbox();
  const queryClient = useQueryClient();
  const { client } = useDaemon();
  const { closeSheet } = useFrameSlots();
  const openWorkbench = useOpenPassWorkbench();
  const people = usePeople().data ?? [];

  const shown: OpenRow[] = [...ownCards.map(systemRow), ...open.rows.map(inboxRowOf)];
  const keys = shown.map((row) => row.key);

  // The row and scroll the builder left Open at come back with them.
  const memory = inboxStateMemory(InboxListState.Open);
  const [selectedKey, setSelectedKey] = useState<string | null>(memory.selected);
  const [lastIndex, setLastIndex] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [awaiting, setAwaiting] = useState<AwaitedPage | null>(null);
  // A failed dismiss belongs to its row, which may not be the open one, so it never touches the draft.
  const [dismissFailure, setDismissFailure] = useState<{
    readonly key: string;
    readonly message: string;
  } | null>(null);
  // A check card's Send Back note, by card, so deselecting the card does not lose it.
  const [sendBackNotes, setSendBackNotes] = useState<Readonly<Record<string, string>>>({});
  const noteRef = useRef<HTMLTextAreaElement>(null);
  // Cards the builder chose to answer themselves instead of sending the drafted message.
  const [myself, setMyself] = useState<ReadonlySet<string>>(new Set());

  // Selection follows the row's key, not its position. The row now shown is pinned at once, so a card that
  // sorts in ahead later never takes over the selection, a half-written note or the keys typed after it; and
  // when the selected row leaves, the row at its index takes its place and the leaver's draft goes with it.
  // Until the list's first page is in, the remembered row has nothing to be found in: it is kept as it is.
  const loaded = !open.isPending;
  // A new search or filter lands on its first row once its first page is in, not on the old row's index.
  const listKey = JSON.stringify(inboxList(search, new Date(now)));
  const [seenList, setSeenList] = useState(listKey);
  const [firstRowDue, setFirstRowDue] = useState(false);
  if (seenList !== listKey) {
    setSeenList(listKey);
    setFirstRowDue(true);
  }
  let fromKey = selectedKey;
  let fromIndex = lastIndex;
  if (firstRowDue && loaded && !open.isPlaceholder) {
    setFirstRowDue(false);
    fromKey = selectedKey !== null && keys.includes(selectedKey) ? selectedKey : (keys[0] ?? null);
    fromIndex = 0;
  }
  const pick = loaded
    ? nextSelection(keys, fromKey, fromIndex)
    : { key: selectedKey, index: lastIndex };
  if (pick.key !== selectedKey) {
    setSelectedKey(pick.key);
    if (selectedKey !== null) setDraft(null);
  }
  if (pick.index !== lastIndex) setLastIndex(pick.index);
  useEffect(() => {
    if (loaded) rememberSelected(InboxListState.Open, pick.key);
  }, [loaded, pick.key]);
  const selectedRow = !loaded || pick.key === null ? null : (shown[pick.index] ?? null);
  const selectedInbox = selectedRow?.kind === OpenRowKind.Inbox ? selectedRow.row : null;
  const selected = selectedInbox?.items[0] ?? null;

  // A move past the loaded end waits for the page it asked for, then goes to the first new row; the page
  // failing, or turning out empty, drops it.
  if (awaiting !== null) {
    const newRow = keys[awaiting.length];
    if (newRow !== undefined) {
      setSelectedKey(newRow);
      setDraft(null);
      setNotice(null);
      setAwaiting(null);
    } else if (
      !open.loadingMore &&
      (!open.hasMore || (open.moreError !== null && open.moreError !== awaiting.failure))
    )
      setAwaiting(null);
  }

  // A draft applies to its own card only, so a card that sorts in ahead never inherits a choice or an error.
  const mine = selectedRow && draft?.id === selectedRow.key ? draft : null;
  const choice = mine?.choice ?? null;
  const note = mine?.note ?? '';
  const error = mine?.error ?? null;
  const effectiveChoice = selected ? (choice ?? recommended(selected)) : null;
  // Until the builder changes it, a question is recorded as the daemon would record it by default.
  const recording =
    mine?.record !== undefined ? mine.record : selected ? defaultRecording(selected) : null;

  usePrefetchNextRow(shown[pick.index + 1]);

  // A drafted message is sent with ⌘↵ only: its options are not live, and a bare Enter sends nothing.
  const previewing =
    selected !== null &&
    !myself.has(selected.id) &&
    [StakeholderMode.Draft, StakeholderMode.Failed].some(
      (m) => m === stakeholderMode(selected, people),
    );

  const select = (row: OpenRow): void => {
    setAwaiting(null);
    setSelectedKey(row.key);
    setDraft(null);
    setNotice(null);
  };

  const patch = (id: string, change: Partial<Omit<Draft, 'id'>>): void => {
    setDraft((current) => ({
      ...(current?.id === id ? current : { id, choice: null, note: '', error: null }),
      ...change,
    }));
  };

  const choose = (row: InboxRow, picked: string): void => {
    setSelectedKey(row.key);
    patch(row.key, { choice: picked, error: null });
  };

  /** Looks a card up again in every list, which is how a card closed elsewhere leaves them. */
  const refreshCard = (id: InboxItemId): void => {
    refreshCardEverywhere(queryClient, client, id);
    void queryClient.invalidateQueries({ queryKey: queryKeys.inbox });
  };

  /**
   * Dismisses every flag of `row`. One already closed elsewhere is skipped, and looked up so it leaves;
   * any other failure stops there and is shown on the row.
   */
  const dismiss = (row: InboxRow): void => {
    if (answer.isPending) return;
    setDismissFailure(null);
    void (async () => {
      for (const item of row.items) {
        try {
          await answer.mutateAsync({ id: item.id, answer: { choice: DISMISS_CHOICE } });
          dropCard(queryClient, client, item.id);
        } catch (failure) {
          if (failure instanceof DaemonRequestError && failure.status === 409) {
            refreshCard(item.id);
            continue;
          }
          setDismissFailure({
            key: row.key,
            message: failure instanceof Error ? failure.message : String(failure),
          });
          break;
        }
      }
    })();
  };

  const submit = (): void => {
    // A pass's Ready pages open the Workbench (spec §4.1, §4.6); each is signed off by its own button.
    if (selectedInbox?.passId !== null && selectedInbox?.passId !== undefined && selected) {
      openWorkbench(selected.projectId);
      return;
    }
    // A check card is answered by its own buttons, never by a key.
    if (
      !selectedInbox ||
      !selected ||
      selected.kind === InboxKind.Check ||
      selected.kind === InboxKind.Plan ||
      answer.isPending
    )
      return;
    if (previewing) return;
    if (isDismissable(selected)) {
      dismiss(selectedInbox);
      return;
    }
    const id = selected.id;
    const key = selectedInbox.key;
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
          dropCard(queryClient, client, id);
          setDraft((current) => (current?.id === key ? null : current));
        },
        onError: (failure) => {
          if (failure instanceof DaemonRequestError && failure.status === 409) {
            // The card left the daemon's list: its row leaves ours, and the builder is told why.
            setNotice(ANSWERED_ELSEWHERE);
            refreshCard(id);
          } else {
            patch(key, { error: failure.message });
          }
        },
      },
    );
  };

  useInboxKeys({
    count: shown.length,
    optionCount:
      selected?.kind === InboxKind.Check || selected?.kind === InboxKind.Plan || previewing
        ? 0
        : (selected?.options.length ?? 0),
    onMove: (delta) => {
      const target = pick.index + delta;
      if (target < 0) return false;
      const next = shown[target];
      if (next !== undefined) {
        select(next);
        return true;
      }
      // Past the loaded end: ask for the next page and move when it lands; at the true end, nothing moves.
      if (!open.hasMore) return false;
      open.loadMore();
      setAwaiting({ length: shown.length, failure: open.moreError });
      return true;
    },
    onChoose: (i) => {
      const option = selected?.options[i];
      if (selectedInbox && option) choose(selectedInbox, option.label);
    },
    onNote: () => {
      if (selectedRow) setSelectedKey(selectedRow.key);
      noteRef.current?.focus();
    },
    onSubmit: submit,
    onDismiss: () => {
      if (selectedInbox && selected && selectedInbox.passId === null && isDismissable(selected))
        dismiss(selectedInbox);
    },
    onHelp,
  });

  const failedHere =
    dismissFailure !== null && dismissFailure.key === selectedRow?.key
      ? dismissFailure.message
      : null;
  const pendingId = answer.isPending ? answer.variables.id : null;
  const selectedItems: readonly InboxItemDto[] = selectedInbox?.items ?? [];
  const list = (
    <InboxRowList
      label="Inbox"
      rows={shown}
      selected={pick.key}
      hasMore={open.hasMore}
      loadingMore={open.loadingMore}
      moreError={open.moreError}
      onNearEnd={open.loadMore}
      initialScroll={memory.scrollTop}
      onScrollTop={(scrollTop) => {
        rememberScroll(InboxListState.Open, scrollTop);
      }}
      focusOnArrival
      onPick={(row) => {
        select(row);
        // Where the panel is a sheet the pick has been made: show the card it chose.
        closeSheet();
      }}
      renderRow={(row) => (
        <InboxRowItem
          row={row}
          state={InboxListState.Open}
          now={now}
          failure={dismissFailure?.key === row.key ? dismissFailure.message : null}
          pending={
            row.kind === OpenRowKind.Inbox && row.row.items.some((item) => item.id === pendingId)
          }
          onDismiss={dismiss}
        />
      )}
    />
  );

  return (
    <>
      {listHost === null ? null : createPortal(list, listHost)}
      {open.error ? (
        <Alert color="red" title="Couldn't load the inbox">
          {open.error.message}
        </Alert>
      ) : null}
      <OpenContent
        row={selectedRow}
        notice={notice}
        empty={!open.isPending && shown.length === 0}
        narrowed={narrowed(search)}
        onClearFilters={onClearFilters}
        card={{
          choice: effectiveChoice,
          note,
          recording,
          error: error ?? failedHere,
          pending: selectedItems.some((item) => item.id === pendingId),
          noteRef,
          onChoose: (value) => {
            if (selectedInbox) choose(selectedInbox, value);
          },
          onNote: (value) => {
            if (!selectedInbox) return;
            setSelectedKey(selectedInbox.key);
            patch(selectedInbox.key, { note: value });
          },
          onRecord: (next) => {
            if (!selectedInbox) return;
            setSelectedKey(selectedInbox.key);
            patch(selectedInbox.key, { record: next });
          },
          sendBackNote: sendBackNotes[selected?.id ?? ''] ?? '',
          onSendBackNote: (value) => {
            if (selected) setSendBackNotes((current) => ({ ...current, [selected.id]: value }));
          },
          onAnsweredElsewhere: () => {
            setNotice(ANSWERED_ELSEWHERE);
          },
          onNoteFocus: () => {
            if (selectedInbox) setSelectedKey(selectedInbox.key);
          },
          onSubmit: submit,
          answeringMyself: selected !== null && myself.has(selected.id),
          onAnswerMyself: (value) => {
            if (!selected) return;
            setMyself((current) => {
              const next = new Set(current);
              if (value) next.add(selected.id);
              else next.delete(selected.id);
              return next;
            });
          },
          onDismiss: () => {
            if (selectedInbox) dismiss(selectedInbox);
          },
        }}
      />
    </>
  );
}
