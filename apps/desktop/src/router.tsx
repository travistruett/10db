import { TaskId } from '@10db/contracts';
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
  component: FactoryPage,
});
const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/inbox',
  component: InboxPage,
});
const boardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/board',
  // `task` opens that task's drawer, so a link from elsewhere (a recent decision) lands on the task.
  validateSearch: (search: Record<string, unknown>): { task?: TaskId } => {
    const task = TaskId.safeParse(search['task']);
    return task.success ? { task: task.data } : {};
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
  inboxRoute,
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
