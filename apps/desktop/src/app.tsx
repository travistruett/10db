import '@mantine/core/styles.css';
import { MantineProvider } from '@mantine/core';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import type { ConnectionResolver } from './daemon/connection';
import { DaemonProvider, type DaemonIntervals } from './daemon/provider';
import type { AppRouter } from './router';
import { cssVariablesResolver, theme } from './theme';

export interface AppProps {
  readonly router: AppRouter;
  readonly queryClient: QueryClient;
  readonly resolve: ConnectionResolver;
  readonly intervals?: DaemonIntervals;
}

export function App({ router, queryClient, resolve, intervals }: AppProps) {
  return (
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      defaultColorScheme="dark"
    >
      <QueryClientProvider client={queryClient}>
        <DaemonProvider resolve={resolve} {...(intervals ? { intervals } : {})}>
          <RouterProvider router={router} />
        </DaemonProvider>
      </QueryClientProvider>
    </MantineProvider>
  );
}
