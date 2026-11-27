import '@mantine/core/styles.css';
import '@mantine/code-highlight/styles.css';
import '@mantine/charts/styles.css';
import 'mantine-datatable/styles.css';
import './light-surfaces.css';
import './plain-links.css';
import { CodeHighlightAdapterProvider } from '@mantine/code-highlight';
import { MantineProvider } from '@mantine/core';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { RouterProvider, type AnyRouter } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { LinkConfirmHost } from './conversation/link-confirm';
import { shikiAdapter } from './conversation/shiki';
import type { ConnectionResolver } from './daemon/connection';
import { DaemonProvider, type DaemonIntervals } from './daemon/provider';
import { cssVariablesResolver, theme } from './theme';

export interface AppProps {
  /** The window's router, or the phone's. */
  readonly router: AnyRouter;
  readonly queryClient: QueryClient;
  readonly resolve: ConnectionResolver;
  readonly intervals?: DaemonIntervals;
  /** What the connecting screen adds when the first connection keeps failing: the phone's way to fix it. */
  readonly connectingHelp?: ReactNode;
}

export function App({ router, queryClient, resolve, intervals, connectingHelp }: AppProps) {
  return (
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      defaultColorScheme="dark"
    >
      <CodeHighlightAdapterProvider adapter={shikiAdapter}>
        <QueryClientProvider client={queryClient}>
          <DaemonProvider
            resolve={resolve}
            {...(intervals ? { intervals } : {})}
            {...(connectingHelp === undefined ? {} : { connectingHelp })}
          >
            <RouterProvider router={router} />
            <LinkConfirmHost />
          </DaemonProvider>
        </QueryClientProvider>
      </CodeHighlightAdapterProvider>
    </MantineProvider>
  );
}
