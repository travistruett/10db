import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { useState } from 'react';
import { App } from '../app';
import type { ConnectionResolver } from '../daemon/connection';
import { createAppRouter } from '../router';
import { RenderModeContext } from './render-context';
import type { RenderParams } from './render-params';

// Shape spec §5.5. The app inside a frame the window draws a screen in: the real app at one route,
// under a render token, with a client that sends reads only and a router that never leaves the screen.

export function RenderApp({ params }: { readonly params: RenderParams }) {
  // Made once: a new router or client on every render would draw the screen again and again.
  const [router] = useState(() =>
    createAppRouter(createMemoryHistory({ initialEntries: [params.path] })),
  );
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false },
          mutations: { retry: false },
        },
      }),
  );
  const [resolve] = useState<ConnectionResolver>(
    () => () => Promise.resolve({ url: params.daemon, token: params.token, readOnly: true }),
  );
  return (
    <RenderModeContext value={params}>
      <App router={router} queryClient={queryClient} resolve={resolve} />
    </RenderModeContext>
  );
}
