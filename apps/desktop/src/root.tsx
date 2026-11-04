import { useEffect, type ReactNode } from 'react';
import { RenderApp } from './screens/render-app';
import { parseRenderParams } from './screens/render-params';

// A page opened with a `render` parameter is a frame the window draws a screen in for a session
// (Shape spec §5.5): the app at one route, read-only, under a render token. If what it was told does
// not parse, it shows nothing: it never becomes the app, which would run under the UI token. It still
// tells its parent why, so the window refuses at once instead of waiting out a load that cannot happen.

const MAX_VALUE = 80;

/** Why a frame address was not believed, naming what it carried. The render token is never repeated. */
function badAddressReason(search: string): string {
  const carried = [...new URLSearchParams(search).entries()]
    .filter(([name]) => name !== 'render')
    .map(
      ([name, value]) =>
        `${name}=${value.length > MAX_VALUE ? `${value.slice(0, MAX_VALUE)}…` : value}`,
    );
  return `The frame's address was not understood, so the screen was not drawn (${carried.length === 0 ? 'it carried no other parameters' : carried.join(', ')}). The daemon must be at http://127.0.0.1:<port>, and project, screen, shape and task must be valid ids.`;
}

function BadFrame({ search }: { readonly search: string }) {
  useEffect(() => {
    window.parent.postMessage(
      { source: 'tendb-screen', kind: 'refused', reason: badAddressReason(search) },
      window.location.origin,
    );
  }, [search]);
  return null;
}

export function Root({ search, app }: { readonly search: string; readonly app: () => ReactNode }) {
  if (new URLSearchParams(search).has('render')) {
    const render = parseRenderParams(search);
    return render === null ? <BadFrame search={search} /> : <RenderApp params={render} />;
  }
  return app();
}
