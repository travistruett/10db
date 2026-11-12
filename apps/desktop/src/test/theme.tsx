import { MantineProvider } from '@mantine/core';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { act, render } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { cssVariablesResolver, theme } from '../theme';

function Themed({ children }: { readonly children: ReactNode }) {
  return (
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      defaultColorScheme="dark"
    >
      {children}
    </MantineProvider>
  );
}

/** One component inside the app's theme, for a view that reads nothing from the daemon. */
export function renderWithTheme(ui: ReactElement) {
  return render(<Themed>{ui}</Themed>);
}

/**
 * One component inside the app's theme and a router of its own at `/`, for a view whose links go
 * elsewhere in the app; following one changes the router's location and draws nothing else.
 */
export async function renderWithRouter(ui: ReactElement) {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => ui }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  await act(() => router.load());
  render(
    <Themed>
      <RouterProvider router={router} />
    </Themed>,
  );
  return { router };
}
