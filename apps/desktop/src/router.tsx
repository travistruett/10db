import { GoalId, PrincipleId, ProjectId, ShapeId, TaskId } from '@10db/contracts';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  redirect,
  type RouterHistory,
} from '@tanstack/react-router';
import { AppError } from './shell/app-error';
import { AppLayout } from './shell/app-layout';
import { ViewBoundary } from './shell/view-boundary';
import { BoardView } from './views/board/board-view';
import { FactoryMode, FactoryView } from './views/factory/factory-view';
import { inboxSearch } from './views/inbox/inbox-search';
import { InboxView } from './views/inbox/inbox-view';
import { KnowledgeView } from './views/knowledge/knowledge-view';
import { EvalsView } from './views/evals/evals-view';
import { recordSearch } from './views/sessions/plan/record/record-tabs';
import { useRenderMode } from './screens/render-context';
import { PlanScreen } from './views/sessions/plan/plan-screen';
import { RecordView } from './views/sessions/plan/record/record-view';
import { SessionsView } from './views/sessions/sessions-view';
import { sessionsSearch } from './views/sessions/sessions-search';
import { settingsSearch } from './views/settings/focus-target';
import {
  isSettingsSectionKey,
  sectionForAddress,
  SettingsSectionKey,
} from './views/settings/sections';
import { SettingsView } from './views/settings/settings-view';
import { workbenchSearch } from './views/workbench/workbench-search';
import { WorkbenchView } from './views/workbench/workbench-view';

function FactoryPage() {
  return (
    <ViewBoundary name="Factory">
      <FactoryView />
    </ViewBoundary>
  );
}

function InboxPage() {
  return (
    <ViewBoundary name="Inbox">
      <InboxView />
    </ViewBoundary>
  );
}

function KnowledgePage() {
  return (
    <ViewBoundary name="Knowledge">
      <KnowledgeView />
    </ViewBoundary>
  );
}

function EvalsPage() {
  return (
    <ViewBoundary name="Evals">
      <EvalsView />
    </ViewBoundary>
  );
}

function BoardPage() {
  return (
    <ViewBoundary name="Board">
      <BoardView />
    </ViewBoundary>
  );
}

function WorkbenchPage() {
  return (
    <ViewBoundary name="UI Workbench">
      <WorkbenchView />
    </ViewBoundary>
  );
}

function SessionsPage() {
  const search = sessionsRoute.useSearch();
  const navigate = sessionsRoute.useNavigate();
  return (
    <ViewBoundary name="Sessions">
      <SessionsView
        search={search}
        onSearch={(next, replace) => {
          void navigate({ search: next, replace });
        }}
      />
    </ViewBoundary>
  );
}

function SettingsPage() {
  return (
    <ViewBoundary name="Settings">
      <SettingsView />
    </ViewBoundary>
  );
}

function PlanScreenPage() {
  const { shapeId } = planScreenRoute.useParams();
  const id = ShapeId.safeParse(shapeId);
  const render = useRenderMode();
  return (
    <ViewBoundary name="Plan">
      {render !== null && id.success ? (
        <PlanScreen shapeId={id.data} />
      ) : (
        <Navigate to="/sessions" />
      )}
    </ViewBoundary>
  );
}

function RecordPage() {
  const { shapeId } = recordRoute.useParams();
  const search = recordRoute.useSearch();
  const navigate = recordRoute.useNavigate();
  const id = ShapeId.safeParse(shapeId);
  return (
    <ViewBoundary name="Plan">
      {id.success ? (
        <RecordView
          shapeId={id.data}
          search={search}
          onSearch={(next) => {
            void navigate({ search: next });
          }}
        />
      ) : null}
    </ViewBoundary>
  );
}

const rootRoute = createRootRoute({ component: AppLayout, errorComponent: AppError });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    // TanStack Router's redirect is thrown by design.
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirects by throwing.
    throw redirect({ to: '/factory' });
  },
});
/** A global view's project filter: absent shows every project. */
function projectFilter(search: Record<string, unknown>): { project?: ProjectId } {
  const project = ProjectId.safeParse(search['project']);
  return project.success ? { project: project.data } : {};
}

const factoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/factory',
  // `goal` opens that goal's row, so the Board's "Open in Factory" lands on the goal expanded. `task` opens
  // that task's drawer over the page, so Back and a shared link reopen it.
  validateSearch: (
    search: Record<string, unknown>,
  ): { goal?: GoalId; project?: ProjectId; view?: FactoryMode; task?: TaskId } => {
    const goal = GoalId.safeParse(search['goal']);
    const task = TaskId.safeParse(search['task']);
    return {
      ...(goal.success ? { goal: goal.data } : {}),
      ...(task.success ? { task: task.data } : {}),
      ...projectFilter(search),
      // Only Metrics is named in the link; Live is the page without it.
      ...(search['view'] === FactoryMode.Metrics ? { view: FactoryMode.Metrics } : {}),
    };
  },
  component: FactoryPage,
});
// A Plan's record: `tab`, `doc`, `rev` and `section` say what is open, each kept only when it parses.
const recordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sessions/record/$shapeId',
  beforeLoad: ({ params }) => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirects by throwing.
    if (!ShapeId.safeParse(params.shapeId).success) throw redirect({ to: '/sessions' });
  },
  validateSearch: recordSearch,
  component: RecordPage,
});
const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/inbox',
  validateSearch: inboxSearch,
  component: InboxPage,
});
const workbenchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workbench',
  validateSearch: workbenchSearch,
  component: WorkbenchPage,
});
const sessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sessions',
  validateSearch: sessionsSearch,
  // A task's tab is gone: an old link to one lands on the task in the Board.
  beforeLoad: ({ search }) => {
    // TanStack Router's redirect is thrown by design.
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirects by throwing.
    if (search.task !== undefined) throw redirect({ to: '/board', search: { task: search.task } });
  },
  component: SessionsPage,
});
const knowledgeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/knowledge',
  // `principle` opens that principle, whatever its state, so a link from elsewhere (a resolved Inbox card)
  // lands on the record and not on a list it may have left.
  validateSearch: (search: Record<string, unknown>): { principle?: PrincipleId } => {
    const principle = PrincipleId.safeParse(search['principle']);
    return principle.success ? { principle: principle.data } : {};
  },
  component: KnowledgePage,
});
const evalsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/evals',
  component: EvalsPage,
});
const boardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/board',
  // `task` opens that task's drawer, so a link from elsewhere (a recent decision) lands on the task.
  // `goal` sets the Board's goal filter, so a Factory row lands on the task among its goal's tasks.
  // `newTask` opens New Task with that title, so a session can offer its own as a Board task.
  validateSearch: (
    search: Record<string, unknown>,
  ): { task?: TaskId; goal?: GoalId; newTask?: string } => {
    const task = TaskId.safeParse(search['task']);
    const goal = GoalId.safeParse(search['goal']);
    const newTask = typeof search['newTask'] === 'string' ? search['newTask'].trim() : '';
    return {
      ...(task.success ? { task: task.data } : {}),
      ...(goal.success ? { goal: goal.data } : {}),
      ...(newTask === '' ? {} : { newTask: newTask.slice(0, 200) }),
    };
  },
  component: BoardPage,
});
const tasksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tasks',
  beforeLoad: () => {
    // TanStack Router's redirect is thrown by design.
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirects by throwing.
    throw redirect({ to: '/board' });
  },
});

const settingsIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  beforeLoad: () => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirects by throwing.
    throw redirect({ to: '/settings/$section', params: { section: SettingsSectionKey.General } });
  },
});
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/$section',
  // `focus` names the card to scroll to and focus, so a link from elsewhere lands on it.
  validateSearch: settingsSearch,
  beforeLoad: ({ params }) => {
    if (!isSettingsSectionKey(params.section))
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirects by throwing.
      throw redirect({
        to: '/settings/$section',
        params: { section: sectionForAddress(params.section) },
      });
  },
  component: SettingsPage,
});

// The Plan screen a session's see_screen draws. Outside the frame the window draws screens in it has
// nothing to show, so it leaves for Sessions.
const planScreenRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/plan-screen/$shapeId',
  component: PlanScreenPage,
});
const routeTree = rootRoute.addChildren([
  planScreenRoute,
  indexRoute,
  boardRoute,
  factoryRoute,
  recordRoute,
  inboxRoute,
  workbenchRoute,
  sessionsRoute,
  knowledgeRoute,
  evalsRoute,
  tasksRoute,
  settingsIndexRoute,
  settingsRoute,
]);

export function createAppRouter(history?: RouterHistory) {
  return createRouter({ routeTree, defaultPreload: 'intent', ...(history ? { history } : {}) });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
}
