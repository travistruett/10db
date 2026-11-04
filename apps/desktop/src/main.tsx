import { QueryClient } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { resolveConnection } from './daemon/connection';
import { createAppRouter } from './router';
import { Root } from './root';

const root = document.getElementById('root');
if (!root) throw new Error('index.html is missing #root');

createRoot(root).render(
  <StrictMode>
    <Root
      search={window.location.search}
      app={() => (
        <App
          router={createAppRouter()}
          queryClient={new QueryClient()}
          resolve={resolveConnection}
        />
      )}
    />
  </StrictMode>,
);
