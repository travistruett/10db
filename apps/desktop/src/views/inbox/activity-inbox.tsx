import { Alert, Stack } from '@mantine/core';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useActivityRows } from '../../daemon/activity-queries';
import { useFrameSlots } from '../../shell/frame-slots';
import { useNow } from '../../shell/relative';
import { ActivityContent } from './activity-content';
import { activityRowOf, ActivityRowItem } from './activity-row-item';
import { InboxEmpty } from './inbox-empty';
import { InboxRowList } from './inbox-row-list';
import {
  activityList,
  inboxStateMemory,
  narrowed,
  PanelOnlyState,
  rememberScroll,
  rememberSelected,
  type InboxSearch,
} from './inbox-search';
import { nextSelection } from './inbox-selection';
import { useInboxKeys } from './use-inbox-keys';

const STATE = PanelOnlyState.Activity;

/**
 * Activity: the notices that tell the builder something and ask nothing, in the panel's list, and the
 * selected one's content beside it. It is never counted and answers nothing, so its keys only move.
 */
export function ActivityInbox({
  search,
  listHost,
  onClearFilters,
}: {
  readonly search: InboxSearch;
  readonly listHost: HTMLElement | null;
  readonly onClearFilters: () => void;
}) {
  const now = useNow();
  const list = activityList(search);
  const rows = useActivityRows(list);
  const { closeSheet } = useFrameSlots();
  const shown = rows.rows.map(activityRowOf);
  const keys = shown.map((row) => row.key);

  const memory = inboxStateMemory(STATE);
  const [selectedKey, setSelectedKey] = useState<string | null>(memory.selected);
  const [lastIndex, setLastIndex] = useState(0);
  // The old rows stay until the new list's first page arrives; a selection they do not hold goes to the first.
  const listKey = JSON.stringify(list);
  const [seenList, setSeenList] = useState(listKey);
  const [firstRowDue, setFirstRowDue] = useState(false);
  if (seenList !== listKey) {
    setSeenList(listKey);
    setFirstRowDue(true);
  }
  const loaded = !rows.isPending;
  let fromKey = selectedKey;
  let fromIndex = lastIndex;
  if (firstRowDue && loaded && !rows.isPlaceholder) {
    setFirstRowDue(false);
    fromKey = selectedKey !== null && keys.includes(selectedKey) ? selectedKey : (keys[0] ?? null);
    fromIndex = 0;
  }
  const pick = loaded
    ? nextSelection(keys, fromKey, fromIndex)
    : { key: selectedKey, index: lastIndex };
  if (pick.key !== selectedKey) setSelectedKey(pick.key);
  if (pick.index !== lastIndex) setLastIndex(pick.index);
  useEffect(() => {
    if (loaded) rememberSelected(STATE, pick.key);
  }, [loaded, pick.key]);
  // A move past the loaded end waits for the page it asked for, then goes to the first new row.
  const [awaiting, setAwaiting] = useState<{
    readonly length: number;
    readonly failure: Error | null;
  } | null>(null);
  if (awaiting !== null) {
    const newRow = keys[awaiting.length];
    if (newRow !== undefined) {
      setSelectedKey(newRow);
      setAwaiting(null);
    } else if (
      !rows.loadingMore &&
      (!rows.hasMore || (rows.moreError !== null && rows.moreError !== awaiting.failure))
    )
      setAwaiting(null);
  }
  const selected = !loaded || pick.key === null ? null : (shown[pick.index] ?? null);

  useInboxKeys({
    count: shown.length,
    optionCount: 0,
    onMove: (delta) => {
      const next = shown[pick.index + delta];
      if (next === undefined) {
        if (delta !== 1 || !rows.hasMore) return false;
        rows.loadMore();
        setAwaiting({ length: shown.length, failure: rows.moreError });
        return true;
      }
      setAwaiting(null);
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
      label="Activity"
      rows={shown}
      selected={pick.key}
      hasMore={rows.hasMore}
      loadingMore={rows.loadingMore}
      moreError={rows.moreError}
      onNearEnd={rows.loadMore}
      initialScroll={memory.scrollTop}
      onScrollTop={(scrollTop) => {
        rememberScroll(STATE, scrollTop);
      }}
      focusOnArrival
      onPick={(row) => {
        setAwaiting(null);
        setSelectedKey(row.key);
        closeSheet();
      }}
      renderRow={(row) => <ActivityRowItem row={row} now={now} />}
    />
  );

  return (
    <>
      {listHost === null ? null : createPortal(picker, listHost)}
      <Stack gap="md">
        {rows.error ? (
          <Alert color="red" title="Couldn't load activity">
            {rows.error.message}
          </Alert>
        ) : null}
        {!rows.isPending && shown.length === 0 ? (
          <InboxEmpty
            empty="Nothing has happened yet"
            narrowed={narrowed(search)}
            onClear={onClearFilters}
          />
        ) : null}
        {selected === null ? null : <ActivityContent key={selected.key} row={selected.row} />}
      </Stack>
    </>
  );
}
