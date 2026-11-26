import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  redirect,
  type RouterHistory,
} from '@tanstack/react-router';
import { Stack, Text } from '@mantine/core';
import { ViewBoundary } from '../shell/view-boundary';
import { AppError } from '../shell/app-error';
import { InboxItemId, InboxListState } from '@10db/contracts';
import { inboxSearch, rememberSelected } from '../views/inbox/inbox-search';
import { InboxView } from '../views/inbox/inbox-view';
import { openCardDirectly } from './deep-link';
import { FactoryGlance } from './factory-glance';
import { ServedFrame } from './served-frame';
import { ThisDevice } from './this-device';

/** The phone's place for an address the window has and the phone does not (the Board, a session): back to the Inbox. */
function NotOnThePhone() {
  return (
    <Stack gap="xs" mt="xl" align="center">
      <Text>That is in the 10db window on your Mac.</Text>
      <Link to="/inbox">Back to the Inbox</Link>
    </Stack>
  );
}

const rootRoute = createRootRoute({
  component: ServedFrame,
  errorComponent: AppError,
  notFoundComponent: NotOnThePhone,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirects by throwing.
    throw redirect({ to: '/inbox' });
  },
});

// The routes keep the window's ids, so the views that read `from: '/inbox'` work unchanged.
const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/inbox',
  validateSearch: inboxSearch,
  component: () => (
    <ViewBoundary name="Inbox">
      <InboxView />
    </ViewBoundary>
  ),
});

// A notification's tap: `/app/inbox/<id>` shows that card, in the Inbox as it would open on it.
const inboxCardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/inbox/$id',
  beforeLoad: ({ params }) => {
    const id = InboxItemId.safeParse(params.id);
    if (id.success) {
      rememberSelected(InboxListState.Open, id.data);
      openCardDirectly(id.data);
    }
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirects by throwing.
    throw redirect({ to: '/inbox' });
  },
});

const factoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/factory',
  component: () => (
    <ViewBoundary name="Factory">
      <FactoryGlance />
    </ViewBoundary>
  ),
});

// The window's Settings address, so the phone's one section reads as Settings › This Device.
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/$section',
  component: () => (
    <ViewBoundary name="Settings">
      <ThisDevice />
    </ViewBoundary>
  ),
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  inboxRoute,
  inboxCardRoute,
  factoryRoute,
  settingsRoute,
]);

/** The phone's router, under `/app`, where the daemon serves it. */
export function createServedRouter(history?: RouterHistory) {
  return createRouter({
    routeTree,
    basepath: '/app',
    defaultPreload: 'intent',
    ...(history ? { history } : {}),
  });
}
