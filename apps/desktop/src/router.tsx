import { GoalId, PrincipleId, ShapeId, TaskId } from '@10db/contracts';
import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  type RouterHistory,
} from '@tanstack/react-router';
import { AppError } from './shell/app-error';
import { AppLayout } from './shell/app-layout';
import { ViewBoundary } from './shell/view-boundary';
import { BoardView } from './views/board/board-view';
import { FactoryView } from './views/factory/factory-view';
import { InboxView } from './views/inbox/inbox-view';
import { KnowledgeView } from './views/knowledge/knowledge-view';
import { ShapeView } from './views/shape/shape-view';
import { isSettingsSectionKey, SettingsSectionKey } from './views/settings/sections';
import { SettingsView } from './views/settings/settings-view';

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

function BoardPage() {
  return (
    <ViewBoundary name="Board">
      <BoardView />
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

function NewShapePage() {
  return (
    <ViewBoundary name="Plan">
      <ShapeView shapeId={null} />
    </ViewBoundary>
  );
}

function ShapePage() {
  const { shapeId } = shapeRoute.useParams();
  const id = ShapeId.safeParse(shapeId);
  return (
    <ViewBoundary name="Plan">
      <ShapeView shapeId={id.success ? id.data : null} />
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
const factoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/factory',
  // `goal` opens that goal's row, so the Board's "Open in Factory" lands on the goal expanded.
  validateSearch: (search: Record<string, unknown>): { goal?: GoalId } => {
    const goal = GoalId.safeParse(search['goal']);
    return goal.success ? { goal: goal.data } : {};
  },
  component: FactoryPage,
});
// The new conversation: nothing exists in the daemon until the first message is sent.
const newShapeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/shape',
  component: NewShapePage,
});
const shapeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/shape/$shapeId',
  beforeLoad: ({ params }) => {
    // A link that isn't a conversation id opens the new conversation instead.
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirects by throwing.
    if (!ShapeId.safeParse(params.shapeId).success) throw redirect({ to: '/shape' });
  },
  component: ShapePage,
});
const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/inbox',
  component: InboxPage,
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
const boardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/board',
  // `task` opens that task's drawer, so a link from elsewhere (a recent decision) lands on the task.
  // `goal` sets the Board's goal filter, so a Factory row lands on the task among its goal's tasks.
  validateSearch: (search: Record<string, unknown>): { task?: TaskId; goal?: GoalId } => {
    const task = TaskId.safeParse(search['task']);
    const goal = GoalId.safeParse(search['goal']);
    return {
      ...(task.success ? { task: task.data } : {}),
      ...(goal.success ? { goal: goal.data } : {}),
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
  beforeLoad: ({ params }) => {
    if (!isSettingsSectionKey(params.section))
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirects by throwing.
      throw redirect({ to: '/settings/$section', params: { section: SettingsSectionKey.General } });
  },
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  boardRoute,
  factoryRoute,
  newShapeRoute,
  shapeRoute,
  inboxRoute,
  knowledgeRoute,
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
