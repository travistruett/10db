import { InboxListState } from '@10db/contracts';
import { Group } from '@mantine/core';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { useProjects } from '../../daemon/queries';
import { ProjectFilter } from '../../shell/project-filter';
import { TitleRow } from '../../shell/title-row';
import { useOpenInboxCount } from './inbox-count';
import { InboxPanel } from './inbox-panel';
import { withProject, withState } from './inbox-search';
import { InboxShortcuts } from './inbox-shortcuts';
import { OpenInbox } from './open-inbox';
import { ResolvedInbox } from './resolved-inbox';
import { WaitingInbox } from './waiting-inbox';

/**
 * The Inbox: its title row, the panel with Open, Waiting and Resolved, and the content for the state the URL
 * names. Each state's content is its own component, so Open's keys are only live while Open is shown.
 */
export function InboxView() {
  const search = useSearch({ from: '/inbox' });
  const navigate = useNavigate({ from: '/inbox' });
  const projects = useProjects();
  const open = useOpenInboxCount();
  const [helpOpen, setHelpOpen] = useState(false);
  const [listHost, setListHost] = useState<HTMLElement | null>(null);
  const state = search.state ?? InboxListState.Open;

  const content = (() => {
    switch (state) {
      case InboxListState.Open:
        return (
          <OpenInbox
            search={search}
            listHost={listHost}
            onHelp={() => {
              setHelpOpen(true);
            }}
          />
        );
      case InboxListState.Waiting:
        return <WaitingInbox project={search.project} />;
      case InboxListState.Resolved:
        return <ResolvedInbox project={search.project} />;
    }
  })();

  return (
    <>
      <TitleRow
        title="Inbox"
        {...(open > 0 ? { meta: `${String(open)} open` } : {})}
        actions={
          <Group gap="sm">
            <ProjectFilter
              projects={projects.data ?? []}
              value={search.project ?? null}
              onChange={(next) => {
                void navigate({ search: withProject(search, next) });
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
        }
      />
      <InboxPanel
        state={state}
        onState={(next) => {
          void navigate({ search: withState(search, next) });
        }}
        onListHost={setListHost}
      />
      {content}
    </>
  );
}
