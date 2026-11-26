import type { MiddlewareHandler } from 'hono';
import { RouteClass, routeClassOf } from './auth-matrix';
import { Listener, listenerOf } from './listener';
import type { ApiEnv } from './request-context';

export interface ListenerAllowlists {
  readonly hosts: readonly string[];
  readonly origins: readonly string[];
}

export interface RequestGuardDeps {
  /** Read per request: the share listener's lists change when sharing turns on, off or the name changes. */
  readonly allowlists: (listener: Listener) => ListenerAllowlists | null; // null: the share listener has no lists yet → 503 but /health
  readonly hostLogin: () => string | null;
}

const isHealth = (method: string, path: string): boolean =>
  routeClassOf(method, path) === RouteClass.Health;

/**
 * Refuses a Host the listener doesn't serve (421), which blocks DNS rebinding. A request with no Host passes on
 * the main listener: no browser omits it, and an in-process `app.request` does. The share listener has no lists
 * until sharing has a name, and then answers 503 to everything but `/health`.
 */
export function hostGuard(deps: RequestGuardDeps): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const listener = listenerOf(c.env);
    const lists = deps.allowlists(listener);
    if (lists === null) {
      if (isHealth(c.req.method, c.req.path)) return next();
      return c.json({ error: 'not_shared' }, 503);
    }
    const host = c.req.header('host');
    if (host === undefined && listener === Listener.Main) return next();
    if (!lists.hosts.some((h) => h.toLowerCase() === host?.toLowerCase()))
      return c.json({ error: 'misdirected' }, 421);
    return next();
  };
}

/** Refuses a request carrying an `Origin` the listener doesn't list; one with none is a non-browser client. */
export function originGuard(deps: RequestGuardDeps): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const origin = c.req.header('origin');
    if (origin === undefined) return next();
    const lists = deps.allowlists(listenerOf(c.env));
    if (!lists?.origins.includes(origin)) return c.json({ error: 'forbidden origin' }, 403);
    return next();
  };
}

/** The Host's name without its port: `[::1]:4317` is `[::1]`. */
function hostName(host: string): string {
  const end = host.startsWith('[') ? host.indexOf(']') + 1 : host.indexOf(':');
  return (end > 0 ? host.slice(0, end) : host).toLowerCase();
}

/**
 * Sets `c.var.remote`: the share listener's requests, and a main-listener request carrying `Tailscale-Headers-Info`,
 * `X-Forwarded-For` or a `*.ts.net` Host. A remote request whose `Tailscale-User-Login` isn't the host's own gets 403;
 * with no such header (a tagged peer) the device token alone decides.
 */
export function remoteMark(deps: RequestGuardDeps): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const host = c.req.header('host');
    const remote =
      listenerOf(c.env) === Listener.Share ||
      c.req.header('tailscale-headers-info') !== undefined ||
      c.req.header('x-forwarded-for') !== undefined ||
      hostName(host ?? '')
        .replace(/\.$/, '')
        .endsWith('.ts.net');
    c.set('remote', remote);
    const login = c.req.header('tailscale-user-login');
    if (remote && login !== undefined) {
      const own = deps.hostLogin();
      if (login.toLowerCase() !== own?.toLowerCase()) return c.json({ error: 'forbidden' }, 403);
    }
    return next();
  };
}
