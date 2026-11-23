import {
  AreaRole,
  PassState,
  passHoldsTasks,
  type InboxItemDto,
  type PageRow,
  type PassJoinRequest,
  type PassDto,
  type PassOpenRequest,
  type PassStartDto,
  type PassViewDto,
  type ProjectViewDto,
  type TaskDto,
  type TaskId,
} from '@10db/contracts';
import { Button, Stack, Text } from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useState, type ReactNode } from 'react';
import {
  useAbandonPass,
  useAddPages,
  useGoalPassPages,
  useLivePass,
  useOpenPass,
  usePassStart,
  useWorkbenchSetup,
} from '../../daemon/pass-queries';
import { useProjectFolder } from '../../daemon/project-folder-queries';
import { useInbox, useTasks } from '../../daemon/queries';
import { PageIntro } from '../../shell/page-intro';
import { TitleRow } from '../../shell/title-row';
import { SettingsSectionKey } from '../settings/sections';
import { PageLoading, PageLoadingShape } from '../../shell/page-loading';
import { useNow } from '../../shell/relative';
import { useSelectedProject } from '../../shell/selected-project';
import { AbandonModal } from './abandon-modal';
import { AddPageModal } from './add-page-modal';
import { ClosePassModal } from './close-pass-modal';
import { ClosedPassLine } from './closed-pass-line';
import { HeaderNotices } from './header-notices';
import { PassHeader } from './pass-header';
import { PassWorkspace } from './pass-workspace';
import { PrButton } from './pr-button';
import { queueRows } from './queue-rows';
import type { PassWorkspaceProps } from './pass-workspace-props';
import { WorkbenchSetup } from './setup/workbench-setup';
import { newPagesOf } from './setup/setup-rules';
import { StartPass } from './start-pass';
import type { WorkbenchSearch } from './workbench-search';

/**
 * The start page's header, the same while it loads, when it fails and once drawn. App Preview
 * opens the project's settings for the pages: where the app runs and how its pictures are taken.
 */
function StartPageHeader({
  project,
}: {
  /** The project's name, which the icons-only rail does not show. */ readonly project?: string;
}) {
  return (
    <>
      <TitleRow
        title="UI Workbench"
        {...(project === undefined ? {} : { meta: project })}
        actions={
          <Button
            variant="subtle"
            color="gray"
            renderRoot={(props) => (
              <Link
                {...props}
                to="/settings/$section"
                params={{ section: SettingsSectionKey.PagesAndPictures }}
              />
            )}
          >
            App Preview
          </Button>
        }
      />
      <PageIntro description="Work through pages with the agents, live." />
    </>
  );
}

/** What the Workbench asks of the daemon; each answers once its route has. */
export interface WorkbenchActions {
  /** Opens a pass: `POST /projects/:projectId/passes`. */
  readonly start: (request: PassOpenRequest) => Promise<unknown>;
  /** Adds pages to the open pass: `POST /passes/:passId/pages`. */
  readonly addPages: (request: PassJoinRequest) => Promise<unknown>;
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
  /** The pages the repository has that the project lacks and the builder has not left out. */
  readonly newPages: readonly PageRow[];
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
type Dialog = 'setup' | 'add-page' | 'close' | 'abandon' | null;

/**
 * The pass whose close finished between two reads of the live pass: it was closing or closed, and now
 * no pass is live or it has settled. Null for anything else, an Abandon among them.
 */
function closeFinished(before: PassDto | null, after: PassDto | null): PassDto | null {
  if (before === null) return null;
  if (before.state !== PassState.Closing && before.state !== PassState.Closed) return null;
  if (after === null || (after.id === before.id && after.state === PassState.Settled))
    return before;
  return null;
}

/**
 * The Workbench (spec §4) for one project: why a pass needs a page area when it has none, the picker
 * while no pass is open, else the pass's header over its workspace.
 */
export function WorkbenchScreen(props: WorkbenchScreenProps) {
  const { project, live, start, tasks, inbox, search, goalPages, now, newPages } = props;
  const { onSelect, renderWorkspace, actions } = props;
  const [dialog, setDialog] = useState<Dialog>(search.setup === true ? 'setup' : null);
  // The live pass last read, and the one whose close finished while it was on screen, which the picker
  // confirms in a line until another pass opens.
  const [lastPass, setLastPass] = useState<PassDto | null>(null);
  const [closed, setClosed] = useState<PassDto | null>(null);
  const current = live?.pass ?? null;
  if (live !== undefined && (current?.id !== lastPass?.id || current?.state !== lastPass?.state)) {
    setLastPass(current);
    setClosed(closeFinished(lastPass, current) ?? (current === null ? closed : null));
  }
  const closeDialog = () => {
    setDialog(null);
  };
  const folder = useProjectFolder(project.id);
  const opening = useMutation({
    mutationFn: (request: PassOpenRequest) => actions.start(request),
  });
  const hasPages = project.areas.some((area) => area.role === AreaRole.Page);
  const loading = <PageLoading shape={PageLoadingShape.List} label="Loading the pages" />;
  // A pass already open, a task's pass of one among them, is shown even where the project names no page.
  const holding = live != null && passHoldsTasks(live.pass.state);
  if (!hasPages && !holding) return <WorkbenchSetup project={project} />;
  // The header is known before the data, so it draws while the pass is read.
  if (live === undefined)
    return (
      <Stack gap="md">
        <StartPageHeader project={project.name} />
        {loading}
      </Stack>
    );
  // A pass that has closed and not settled is one line above the picker: the next pass may stack on it.
  if ((live === null || !passHoldsTasks(live.pass.state)) && dialog === 'setup')
    return <WorkbenchSetup project={project} onBack={closeDialog} onApplied={closeDialog} />;
  if (live === null || !passHoldsTasks(live.pass.state))
    return (
      <Stack gap="md">
        <StartPageHeader project={project.name} />
        {closed === null ? null : (
          <Text size="sm" role="status">
            {`${closed.name} finished; its work is on ${closed.returnBranch}.`}
          </Text>
        )}
        {live === null ? null : (
          <>
            <ClosedPassLine view={live} inbox={inbox} />
            <HeaderNotices view={live} inbox={inbox} />
          </>
        )}
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
            folder={folder}
            now={now}
            onStart={(request) => {
              opening.mutate(request);
            }}
            starting={opening.isPending}
            error={opening.error?.message ?? null}
            setUp={{
              newPages,
              onOpen: () => {
                setDialog('setup');
              },
            }}
          />
        )}
      </Stack>
    );
  return (
    // The open pass takes the height the shell leaves, so the queue and the page run to its foot.
    <Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
      <PassHeader
        project={project}
        view={live}
        inbox={inbox}
        now={now}
        pullRequest={<PrButton view={live} />}
        onClose={() => {
          setDialog('close');
        }}
        onAbandon={() => {
          setDialog('abandon');
        }}
      />
      <HeaderNotices view={live} inbox={inbox} />
      {renderWorkspace({
        view: live,
        inbox,
        project,
        selected: search.task ?? null,
        onSelect,
        onAddPage: () => {
          setDialog('add-page');
        },
        passActions: {
          onClose: () => {
            setDialog('close');
          },
          onAbandon: () => {
            setDialog('abandon');
          },
        },
      })}
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
      {dialog === 'close' ? <ClosePassModal view={live} onClose={closeDialog} /> : null}
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
  const inboxRead = useInbox();
  const inbox = inboxRead.data ?? [];
  const goalPages = useGoalPassPages(search.goal ?? null).data?.pages ?? [];
  const now = useNow(CLOCK_TICK_MS);
  const opening = useOpenPass(project.id);
  // The setup is offered only above the list, so it is read only while no pass is open.
  const noPassOpen =
    live.data === null || (live.data !== undefined && !passHoldsTasks(live.data.pass.state));
  const setup = useWorkbenchSetup(project.id, hasPages && noPassOpen);
  const adding = useAddPages();
  const abandoning = useAbandonPass();
  const passId = (): PassViewDto['pass']['id'] => {
    const view = live.data;
    if (view === null || view === undefined)
      throw new NoPassOpenError(`${project.name} has no pages open`);
    return view.pass.id;
  };
  // With no page of the pass in the address, the queue's first page is shown; it goes into the address
  // in place, so a queue that reorders on live data never swaps the page (and its composer) under the
  // builder, and only the page on screen is marked opened.
  const view = live.data;
  const named = view?.pages.some((page) => page.taskId === search.task) ?? false;
  // The queue ranks a page by its Inbox items too, so the pin waits while the Inbox is first read; a
  // failed read pins with none, rather than leave the page to follow the queue.
  const pin =
    view == null || !passHoldsTasks(view.pass.state) || named || inboxRead.isPending
      ? null
      : (queueRows(view, inbox, now)[0]?.page.taskId ?? null);
  useEffect(() => {
    if (pin !== null) void navigate({ to: '/workbench', search: { task: pin }, replace: true });
  }, [pin, navigate]);
  const actions: WorkbenchActions = {
    start: (request) => opening.mutateAsync(request),
    addPages: (request) => adding.mutateAsync({ passId: passId(), request }),
    abandon: () => abandoning.mutateAsync(passId()),
  };
  // A read that failed with nothing read before says why; a refetch that fails keeps what was read, so
  // a daemon blip never takes the pass, and its drafts, off the screen. The picker needs what Start Pass
  // says, an open pass does not.
  const failed =
    (live.data === undefined ? live.error : null) ??
    (live.data !== undefined &&
    (live.data === null || !passHoldsTasks(live.data.pass.state)) &&
    hasPages &&
    start.data === undefined
      ? start.error
      : null);
  if (failed !== null)
    return (
      <Stack gap="md">
        <StartPageHeader project={project.name} />
        <Text size="sm" c="red">{`The UI Workbench could not be read: ${failed.message}`}</Text>
      </Stack>
    );
  return (
    <WorkbenchScreen
      project={project}
      live={live.data}
      start={start.data}
      tasks={tasks}
      inbox={inbox}
      search={search}
      goalPages={goalPages}
      newPages={setup.data === undefined ? [] : newPagesOf(setup.data, project.leftOutPages)}
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
        <StartPageHeader />
      </Stack>
    );
  return <ProjectWorkbench key={project.id} project={project} />;
}
