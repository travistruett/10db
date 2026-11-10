// Workbench spec docs/superpowers/specs/2026-11-09-10db-workbench-design.md §13: the browser that takes
// pictures reaches the app's own host and port and nothing else. The daemon's API listens on loopback
// too, on another port, and a page that reached it would do so with the builder's dev session.

/** The port a URL reaches: its own, else its scheme's default. */
function portOf(url: URL): string {
  if (url.port !== '') return url.port;
  return url.protocol === 'https:' || url.protocol === 'wss:' ? '443' : '80';
}

function parse(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Whether `url` names exactly the app's host and port, by whatever scheme. */
function sameHostAndPort(app: URL, url: URL): boolean {
  return url.hostname === app.hostname && portOf(url) === portOf(app);
}

/**
 * Whether the daemon's proxy forwards a request Chromium sent it: an absolute-form request on the app's
 * origin, or a `CONNECT` (a WebSocket, or `https`) to exactly the app's host and port. Nothing passes
 * while no app is allowed (`appUrl` null), and a request made to the proxy as if it were a server
 * (origin-form) never does.
 */
export function proxyAllows(
  appUrl: string | null,
  request: { readonly method: string; readonly target: string },
): boolean {
  if (appUrl === null) return false;
  const app = parse(appUrl);
  if (app === null) return false;
  if (request.method.toUpperCase() === 'CONNECT') {
    // Authority form, `host:port`: the port is always there.
    if (!/:\d+$/.test(request.target)) return false;
    const url = parse(`http://${request.target}`);
    return (
      url !== null &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.port !== '' &&
      sameHostAndPort(app, url)
    );
  }
  if (!/^https?:\/\//i.test(request.target)) return false;
  const url = parse(request.target);
  return url !== null && url.username === '' && url.password === '' && url.origin === app.origin;
}

/**
 * The first check, in Playwright's routing, which names what it refused in the log: the app's own
 * origin, a WebSocket to the app's host and port, and the page's own `data:`, `blob:` and `about:blank`.
 * It never sees a redirect's next hop, so the proxy is what holds.
 */
export function requestAllowed(appOrigin: string, raw: string): boolean {
  if (raw === 'about:blank') return true;
  const url = parse(raw);
  const app = parse(appOrigin);
  if (url === null || app === null) return false;
  switch (url.protocol) {
    case 'data:':
    case 'blob:':
      return true;
    case 'http:':
    case 'https:':
      return url.origin === app.origin;
    case 'ws:':
    case 'wss:':
      return sameHostAndPort(app, url);
    default:
      return false;
  }
}
