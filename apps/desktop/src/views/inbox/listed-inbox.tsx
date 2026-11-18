import { InboxListState } from '@10db/contracts';
import { Alert, Stack, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useInboxRows } from '../../daemon/inbox-queries';
import { useSlackConnection } from '../../daemon/people';
import { useFrameSlots } from '../../shell/frame-slots';
import { useNow } from '../../shell/relative';
import { InboxEmpty } from './inbox-empty';
import { InboxRowList } from './inbox-row-list';
import { inboxRowOf, InboxRowItem, OpenRowKind, type OpenRow } from './inbox-row-item';
import {
  inboxList,
  inboxStateMemory,
  narrowed,
  rememberScroll,
  rememberSelected,
  type InboxSearch,
} from './inbox-search';
import { nextSelection } from './inbox-selection';
import { ResolvedContent } from './resolved-content';
import { useInboxKeys } from './use-inbox-keys';
import { WaitingContent } from './waiting-content';

const EMPTY_WORDS: Record<'waiting' | 'resolved', string> = {
  waiting: 'Nothing is waiting on anyone',
  resolved: 'Nothing resolved yet',
};

function Rows({
  state,
  search,
  listHost,
  onClearFilters,
}: {
  readonly state: 'waiting' | 'resolved';
  readonly search: InboxSearch;
  readonly listHost: HTMLElement | null;
  readonly onClearFilters: () => void;
}) {
  const now = useNow();
  const list = inboxList(search, new Date(now));
  const rows = useInboxRows(list);
  const { closeSheet } = useFrameSlots();
  const shown: OpenRow[] = rows.rows.map(inboxRowOf);
  const keys = shown.map((row) => row.key);

  // The row and scroll the builder left the state at come back with them.
  const memory = inboxStateMemory(state);
  const [selectedKey, setSelectedKey] = useState<string | null>(memory.selected);
  const [lastIndex, setLastIndex] = useState(0);
  // The old rows stay until the new list's first page arrives; a selection they do not hold goes to the first.
  const listKey = JSON.stringify(list);
  const [seenList, setSeenList] = useState(listKey);
  if (seenList !== listKey) {
    setSeenList(listKey);
    setLastIndex(0);
  }
  const pick = nextSelection(keys, selectedKey, lastIndex);
  if (pick.key !== selectedKey) setSelectedKey(pick.key);
  if (pick.index !== lastIndex) setLastIndex(pick.index);
  useEffect(() => {
    rememberSelected(state, pick.key);
  }, [state, pick.key]);
  const selectedRow = pick.key === null ? null : (shown[pick.index] ?? null);
  const item = selectedRow?.kind === OpenRowKind.Inbox ? selectedRow.row.items[0] : null;

  useInboxKeys({
    count: shown.length,
    optionCount: 0,
    onMove: (delta) => {
      const next = shown[pick.index + delta];
      if (next === undefined) {
        // Past the loaded end: the next page loads, and the key can be pressed again.
        if (delta === 1) rows.loadMore();
        return false;
      }
      setSelectedKey(next.key);
      return true;
    },
    onChoose: () => undefined,
    onNote: () => undefined,
    onSubmit: () => undefined,
    onDismiss: () => undefined,
    onHelp: () => undefined,
  });

  const picker = (
    <InboxRowList
      label="Inbox"
      rows={shown}
      selected={pick.key}
      hasMore={rows.hasMore}
      loadingMore={rows.loadingMore}
      moreError={rows.moreError}
      onNearEnd={rows.loadMore}
      initialScroll={memory.scrollTop}
      onScrollTop={(scrollTop) => {
        rememberScroll(state, scrollTop);
      }}
      focusOnArrival
      onPick={(row) => {
        setSelectedKey(row.key);
        // Where the panel is a sheet the pick has been made: show the card it chose.
        closeSheet();
      }}
      renderRow={(row) => (
        <InboxRowItem
          row={row}
          state={state}
          now={now}
          failure={null}
          pending={false}
          onDismiss={() => undefined}
        />
      )}
    />
  );

  return (
    <>
      {listHost === null ? null : createPortal(picker, listHost)}
      <Stack gap="md">
        {rows.error ? (
          <Alert color="red" title="Couldn't load the inbox">
            {rows.error.message}
          </Alert>
        ) : null}
        {!rows.isPending && shown.length === 0 ? (
          <InboxEmpty
            empty={EMPTY_WORDS[state]}
            narrowed={narrowed(search)}
            onClear={onClearFilters}
          />
        ) : null}
        {item === null ? null : state === InboxListState.Waiting ? (
          <WaitingContent key={item.id} item={item} />
        ) : (
          <ResolvedContent key={item.id} item={item} />
        )}
      </Stack>
    </>
  );
}

/**
 * Waiting and Resolved: the state's rows in the panel's list, and the selected row's content. Without a Slack
 * connection nobody can read a reply, so a sent question waits in Open and Waiting says so, asking for no page.
 */
export function ListedInbox({
  state,
  search,
  listHost,
  onClearFilters,
}: {
  readonly state: 'waiting' | 'resolved';
  readonly search: InboxSearch;
  readonly listHost: HTMLElement | null;
  readonly onClearFilters: () => void;
}) {
  const connection = useSlackConnection();
  if (state === InboxListState.Waiting) {
    if (connection.data === undefined) return null;
    if (connection.data.state !== 'connected')
      return <Text c="dimmed">Slack isn't connected, so questions sent there wait in Open.</Text>;
  }
  return <Rows state={state} search={search} listHost={listHost} onClearFilters={onClearFilters} />;
}
