import { ScreenRefusalInput } from '@10db/contracts';
import { useEffect, type ReactNode } from 'react';
import { RenderApp } from './screens/render-app';
import { parseRenderParams } from './screens/render-params';

// A page opened with a `render` parameter is a frame the window draws a screen in for a session
// (Shape spec §5.5): the app at one route, read-only, under a render token. If what it was told does
// not parse, it shows nothing: it never becomes the app, which would run under the UI token. It still
// tells its parent why, so the window refuses at once instead of waiting out a load that cannot happen.

/** The longest a value is shown, tried first; a tighter cap is used when the reason would not fit. */
const VALUE_CAPS = [80, 40, 24, 12, 4];
/** The most a refusal's reason may be: the daemon refuses a longer one, and the host cuts it. */
const REASON_MAX = ScreenRefusalInput.shape.reason.maxLength ?? 300;
const ADVICE = 'Need daemon=http://127.0.0.1:<port> and valid project, screen, shape, task ids.';

function cut(value: string, cap: number): string {
  return value.length > cap ? `${value.slice(0, cap)}…` : value;
}

/**
 * Why a frame address was not believed, naming what it carried, then what it needs. The advice is
 * fixed and always whole: it is the values that give way, to a tighter cap, so the reason fits what
 * the daemon takes. The render token is never repeated.
 */
function badAddressReason(search: string): string {
  const entries = [...new URLSearchParams(search).entries()].filter(([name]) => name !== 'render');
  const reasonWith = (carried: string): string =>
    `Frame address not understood (${carried}). ${ADVICE}`;
  for (const cap of VALUE_CAPS) {
    const carried =
      entries.length === 0
        ? 'no other parameters'
        : entries.map(([name, value]) => `${name}=${cut(value, cap)}`).join(', ');
    const reason = reasonWith(carried);
    if (reason.length <= REASON_MAX) return reason;
  }
  // Many parameters: keep the first ones that fit, so the bad daemon value that leads them survives.
  const room = REASON_MAX - reasonWith('…').length;
  const carried = entries.map(([name, value]) => `${name}=${cut(value, 4)}`).join(', ');
  return reasonWith(`${carried.slice(0, room)}…`);
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
