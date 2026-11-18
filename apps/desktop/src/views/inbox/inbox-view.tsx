import { InboxListState } from '@10db/contracts';
import { Group } from '@mantine/core';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { TitleRow } from '../../shell/title-row';
import { useOpenInboxCount } from './inbox-count';
import { ActivityInbox } from './activity-inbox';
import { InboxPanel } from './inbox-panel';
import { ListedInbox } from './listed-inbox';
import { lastInboxSearch, withoutFilters, withoutQuery, withState } from './inbox-search';
import { InboxShortcuts } from './inbox-shortcuts';
import { OpenInbox } from './open-inbox';

/**
 * The Inbox: its title row, the panel with Open, Waiting, Resolved and Activity, and the content for the state the URL
 * names. Each state's content is its own component, so Open's keys are only live while Open is shown.
 */
export function InboxView() {
  const search = useSearch({ from: '/inbox' });
  const navigate = useNavigate({ from: '/inbox' });
  const open = useOpenInboxCount();
  const [helpOpen, setHelpOpen] = useState(false);
  const [listHost, setListHost] = useState<HTMLElement | null>(null);
  const state = search.state ?? InboxListState.Open;
  // The rail opens the Inbox as it was left.
  useEffect(() => {
    lastInboxSearch.set(search);
  }, [search]);

  const clearFilters = (): void => {
    void navigate({ search: withoutFilters(withoutQuery(search)), replace: true });
  };

  const content = (() => {
    switch (state) {
      case InboxListState.Open:
        return (
          <OpenInbox
            search={search}
            listHost={listHost}
            onClearFilters={clearFilters}
            onHelp={() => {
              setHelpOpen(true);
            }}
          />
        );
      case 'activity':
        return <ActivityInbox search={search} listHost={listHost} onClearFilters={clearFilters} />;
      case InboxListState.Waiting:
      case InboxListState.Resolved:
        return (
          <ListedInbox
            state={state}
            search={search}
            listHost={listHost}
            onClearFilters={clearFilters}
          />
        );
    }
  })();

  return (
    <>
      <TitleRow
        title="Inbox"
        {...(open > 0 ? { meta: `${String(open)} open` } : {})}
        actions={
          <Group gap="sm">
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
        }
      />
      <InboxPanel
        state={state}
        search={search}
        onState={(next) => {
          void navigate({ search: withState(search, next) });
        }}
        onSearch={(next) => {
          void navigate({ search: next, replace: true });
        }}
        onListHost={setListHost}
      />
      {content}
    </>
  );
}
