import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  type RouterHistory,
} from '@tanstack/react-router';
import { AppLayout } from './shell/app-layout';
import { ViewBoundary } from './shell/view-boundary';
import { BoardView } from './views/board/board-view';
import { FactoryView } from './views/factory/factory-view';
import { InboxView } from './views/inbox/inbox-view';

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

const rootRoute = createRootRoute({ component: AppLayout });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    // TanStack Router's redirect is thrown by design.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
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
  component: BoardPage,
});
const tasksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tasks',
  beforeLoad: () => {
    // TanStack Router's redirect is thrown by design.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect({ to: '/board' });
  },
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  boardRoute,
  factoryRoute,
  inboxRoute,
  tasksRoute,
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
