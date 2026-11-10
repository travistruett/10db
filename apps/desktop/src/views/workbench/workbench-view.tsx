import {
  AreaRole,
  type InboxItemDto,
  type PagesProposalDto,
  type PassJoinRequest,
  type PassOpenRequest,
  type PassRename,
  type PassStartDto,
  type PassViewDto,
  type ProjectViewDto,
  type TaskDto,
  type TaskId,
} from '@10db/contracts';
import { Group, Loader, Stack, Title } from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { AbandonModal } from './abandon-modal';
import { AddPageModal } from './add-page-modal';
import { PassHeader } from './pass-header';
import type { PassWorkspaceProps } from './pass-workspace-props';
import { NoPageAreas, ProposePagesModal } from './propose-pages-modal';
import { RenameModal } from './rename-modal';
import { StartPass } from './start-pass';
import type { WorkbenchSearch } from './workbench-search';

/** What the Workbench asks of the daemon; each answers once its route has. */
export interface WorkbenchActions {
  /** Opens a pass: `POST /projects/:projectId/passes`. */
  readonly start: (request: PassOpenRequest) => Promise<unknown>;
  /** Proposes page areas: `POST /projects/:projectId/propose-page-areas`. */
  readonly propose: () => Promise<PagesProposalDto>;
  /** Adds pages to the open pass: `POST /passes/:passId/pages`. */
  readonly addPages: (request: PassJoinRequest) => Promise<unknown>;
  /** Renames the open pass: `PATCH /passes/:passId`. */
  readonly rename: (body: PassRename) => Promise<unknown>;
  /** Abandons the open pass. */
  readonly abandon: () => Promise<unknown>;
}

export interface WorkbenchScreenProps {
  readonly project: ProjectViewDto;
  /** The project's live pass; null with none, undefined until read. */
  readonly live: PassViewDto | null | undefined;
  /** What Start Pass says; undefined until read. */
  readonly start: PassStartDto | undefined;
  /** The project's tasks. */
  readonly tasks: readonly TaskDto[];
  /** The open Inbox items. */
  readonly inbox: readonly InboxItemDto[];
  readonly search: WorkbenchSearch;
  /** The pages a `goal` link's tasks committed in, which the picker starts ticked. */
  readonly goalPages: readonly string[];
  /** Now, in epoch milliseconds. */
  readonly now: number;
  /** Selects a page of the pass; the view's address holds the selection. */
  readonly onSelect: (taskId: TaskId) => void;
  /** Draws the pass's queue and the selected page's thread. */
  readonly renderWorkspace: (props: PassWorkspaceProps) => ReactNode;
  readonly actions: WorkbenchActions;
}

/** Which dialog the screen holds open. */
type Dialog = 'propose' | 'add-page' | 'rename' | 'abandon' | null;

/**
 * The Workbench (spec §4) for one project: why a pass needs a page area when it has none, the picker
 * while no pass is open, else the pass's header over its workspace.
 */
export function WorkbenchScreen(props: WorkbenchScreenProps) {
  const { project, live, start, tasks, inbox, search, goalPages, now } = props;
  const { onSelect, renderWorkspace, actions } = props;
  const [dialog, setDialog] = useState<Dialog>(null);
  const closeDialog = () => {
    setDialog(null);
  };
  const opening = useMutation({
    mutationFn: (request: PassOpenRequest) => actions.start(request),
  });
  const hasPages = project.areas.some((area) => area.role === AreaRole.Page);
  const loading = (
    <Group>
      <Loader size="sm" role="status" aria-label="Loading the pages" />
    </Group>
  );
  if (!hasPages)
    return (
      <Stack gap="md">
        <Title order={2}>Workbench</Title>
        <NoPageAreas
          onPropose={() => {
            setDialog('propose');
          }}
        />
        {dialog === 'propose' ? (
          <ProposePagesModal
            project={project}
            opened
            onClose={closeDialog}
            propose={actions.propose}
          />
        ) : null}
      </Stack>
    );
  if (live === undefined) return loading;
  if (live === null)
    return (
      <Stack gap="md">
        <Title order={2}>Workbench</Title>
        {start === undefined ? (
          loading
        ) : (
          <StartPass
            // Pages a goal's link names arrive after the view; the picker starts again ticked with them.
            key={goalPages.join('\n')}
            project={project}
            start={start}
            tasks={tasks}
            initial={{ pages: goalPages, taskIds: search.tasks ?? [] }}
            goalId={search.goal ?? null}
            now={now}
            onStart={(request) => {
              opening.mutate(request);
            }}
            starting={opening.isPending}
            error={opening.error?.message ?? null}
          />
        )}
      </Stack>
    );
  return (
    <Stack gap="sm">
      <PassHeader
        project={project}
        view={live}
        inbox={inbox}
        now={now}
        onAddPage={() => {
          setDialog('add-page');
        }}
        onRename={() => {
          setDialog('rename');
        }}
        onAbandon={() => {
          setDialog('abandon');
        }}
      />
      {renderWorkspace({ view: live, inbox, project, selected: search.task ?? null, onSelect })}
      {dialog === 'add-page' ? (
        <AddPageModal
          project={project}
          view={live}
          start={start}
          tasks={tasks}
          now={now}
          onClose={closeDialog}
          add={actions.addPages}
        />
      ) : null}
      {dialog === 'rename' ? (
        <RenameModal pass={live.pass} onClose={closeDialog} rename={actions.rename} />
      ) : null}
      {dialog === 'abandon' ? (
        <AbandonModal
          view={live}
          inbox={inbox}
          now={now}
          onClose={closeDialog}
          abandon={actions.abandon}
        />
      ) : null}
    </Stack>
  );
}

/** The Workbench route (spec §4): work through pages with the agents, live in Your folder. */
export function WorkbenchView() {
  return (
    <Stack gap="md">
      <Title order={2}>Workbench</Title>
    </Stack>
  );
}
