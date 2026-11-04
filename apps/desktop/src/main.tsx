import { QueryClient } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { resolveConnection } from './daemon/connection';
import { createAppRouter } from './router';
import { RenderApp } from './screens/render-app';
import { parseRenderParams } from './screens/render-params';

const root = document.getElementById('root');
if (!root) throw new Error('index.html is missing #root');

// A page opened with a render token is a frame the window draws a screen in for a session (Shape spec
// §5.5): the app at one route, read-only. Anything else is the app.
const render = parseRenderParams(window.location.search);

createRoot(root).render(
  <StrictMode>
    {render === null ? (
      <App router={createAppRouter()} queryClient={new QueryClient()} resolve={resolveConnection} />
    ) : (
      <RenderApp params={render} />
    )}
  </StrictMode>,
);
