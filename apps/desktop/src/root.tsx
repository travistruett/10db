import type { ReactNode } from 'react';
import { RenderApp } from './screens/render-app';
import { parseRenderParams } from './screens/render-params';

// A page opened with a `render` parameter is a frame the window draws a screen in for a session
// (Shape spec §5.5): the app at one route, read-only, under a render token. If what it was told does
// not parse, it shows nothing: it never becomes the app, which would run under the UI token.

export function Root({ search, app }: { readonly search: string; readonly app: () => ReactNode }) {
  if (new URLSearchParams(search).has('render')) {
    const render = parseRenderParams(search);
    return render === null ? null : <RenderApp params={render} />;
  }
  return app();
}
