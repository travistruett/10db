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
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import {
  useAbandonPass,
  useAddPages,
  useGoalPassPages,
  useLivePass,
  useOpenPass,
  usePassStart,
  useProposePageAreas,
  useRenamePass,
} from '../../daemon/pass-queries';
import { useInbox, useTasks } from '../../daemon/queries';
import { useNow } from '../../shell/relative';
import { useSelectedProject } from '../../shell/selected-project';
import { AbandonModal } from './abandon-modal';
import { AddPageModal } from './add-page-modal';
import { PassHeader } from './pass-header';
import { PassWorkspace } from './pass-workspace';
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

/** The header's minutes and the timing hint move once a minute; half that keeps them on time. */
const CLOCK_TICK_MS = 30_000;

/** Thrown for a pass action asked of a project with no pass open. */
class NoPassOpenError extends Error {
  override readonly name = 'NoPassOpenError';
}

/** The Workbench of one project, over the daemon. */
function ProjectWorkbench({ project }: { readonly project: ProjectViewDto }) {
  const search = useSearch({ from: '/workbench' });
  const navigate = useNavigate();
  const hasPages = project.areas.some((area) => area.role === AreaRole.Page);
  const live = useLivePass(project.id);
  const start = usePassStart(project.id, hasPages);
  const tasks = useTasks(project.id).data ?? [];
  const inbox = useInbox().data ?? [];
  const goalPages = useGoalPassPages(search.goal ?? null).data?.pages ?? [];
  const now = useNow(CLOCK_TICK_MS);
  const opening = useOpenPass(project.id);
  const proposing = useProposePageAreas(project.id);
  const adding = useAddPages();
  const renaming = useRenamePass();
  const abandoning = useAbandonPass();
  const passId = (): PassViewDto['pass']['id'] => {
    const view = live.data;
    if (view === null || view === undefined)
      throw new NoPassOpenError(`${project.name} has no pass open`);
    return view.pass.id;
  };
  const actions: WorkbenchActions = {
    start: (request) => opening.mutateAsync(request),
    propose: () => proposing.mutateAsync(),
    addPages: (request) => adding.mutateAsync({ passId: passId(), request }),
    rename: (body) => renaming.mutateAsync({ passId: passId(), body }),
    abandon: () => abandoning.mutateAsync(passId()),
  };
  return (
    <WorkbenchScreen
      project={project}
      live={live.data}
      start={start.data}
      tasks={tasks}
      inbox={inbox}
      search={search}
      goalPages={goalPages}
      now={now}
      onSelect={(task) => {
        void navigate({ to: '/workbench', search: { task } });
      }}
      renderWorkspace={(props) => <PassWorkspace {...props} />}
      actions={actions}
    />
  );
}

/** The Workbench route (spec §4): work through pages with the agents, live in Your folder. */
export function WorkbenchView() {
  const { project } = useSelectedProject();
  if (project === null)
    return (
      <Stack gap="md">
        <Title order={2}>Workbench</Title>
      </Stack>
    );
  return <ProjectWorkbench key={project.id} project={project} />;
}
