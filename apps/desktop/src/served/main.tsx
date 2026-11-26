import { MantineProvider } from '@mantine/core';
import { QueryClient } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@mantine/core/styles.css';
import { App } from '../app';
import { cssVariablesResolver, theme } from '../theme';
import { readDevice } from './device-session';
import { PairPage } from './pair-page';
import { createServedRouter } from './served-router';
import { resolveServedConnection } from './served-connection';
import { UnpairedPage } from './unpaired-page';

const root = document.getElementById('root');
if (!root) throw new Error('app.html is missing #root');

const PAIR_PATH = '/app/pair';

/** The pairing page and the notice for a phone with no token need no daemon; the rest is the app. */
function Served() {
  if (window.location.pathname.replace(/\/$/, '') === PAIR_PATH) {
    return (
      <MantineProvider
        theme={theme}
        cssVariablesResolver={cssVariablesResolver}
        defaultColorScheme="dark"
      >
        <PairPage />
      </MantineProvider>
    );
  }
  // A page run by Vite (`pnpm dev`) with no pairing uses the dev connection (served-connection.ts).
  if (readDevice() === null && !import.meta.env.DEV) {
    return (
      <MantineProvider
        theme={theme}
        cssVariablesResolver={cssVariablesResolver}
        defaultColorScheme="dark"
      >
        <UnpairedPage />
      </MantineProvider>
    );
  }
  return (
    <App
      router={createServedRouter()}
      queryClient={new QueryClient()}
      resolve={resolveServedConnection}
    />
  );
}

createRoot(root).render(
  <StrictMode>
    <Served />
  </StrictMode>,
);

// The worker keeps the shell (and later shows notifications). Vite's dev server serves no worker file.
if (!import.meta.env.DEV && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' });
}
