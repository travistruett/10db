import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ViewBoundary } from '../shell/view-boundary';
import { RenderLayout } from './render-layout';
import { RenderModeContext } from './render-context';

// Shape spec §5.5: the frame tells the window a screen has crashed by the boundary's own mark in the
// DOM, never by words that a task's title or a Plan message can quote.

function Crash(): never {
  throw new Error('the board is on fire');
}

let heard: unknown[];
const listen = (event: MessageEvent): void => {
  const data = event.data as { source?: string };
  if (data.source === 'tendb-screen') heard.push(data);
};
beforeEach(() => {
  heard = [];
  window.addEventListener('message', listen);
});
afterEach(() => {
  window.removeEventListener('message', listen);
});

function draw(page: () => React.JSX.Element): void {
  const root = createRootRoute({ component: RenderLayout });
  const route = createRoute({ getParentRoute: () => root, path: '/', component: page });
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient()}>
        <RenderModeContext
          value={{
            token: 't',
            daemon: 'http://127.0.0.1:4999',
            projectId: 'prj_x' as never,
            screen: 'board',
            path: '/',
          }}
        >
          <RouterProvider router={router} />
        </RenderModeContext>
      </QueryClientProvider>
    </MantineProvider>,
  );
}

describe('the frame’s verdict on a crash', () => {
  it('refuses a screen whose view crashed, naming the view and why', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      draw(() => (
        <ViewBoundary name="Board">
          <Crash />
        </ViewBoundary>
      ));
      await waitFor(() => {
        expect(heard).toHaveLength(1);
      });
      expect(heard[0]).toEqual({
        source: 'tendb-screen',
        kind: 'refused',
        reason: 'The Board crashed: Something went wrong in Board. (the board is on fire)',
      });
    } finally {
      quiet.mockRestore();
    }
  });
});
