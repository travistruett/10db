import { Listener } from './listener';

export const RouteClass = {
  Health: 'health',
  Mcp: 'mcp',
  BuilderMcp: 'builder_mcp',
  ScreensClaim: 'screens_claim',
  Stream: 'stream',
  Ticket: 'ticket',
  Pair: 'pair',
  AppStatic: 'app_static',
  Api: 'api',
} as const;
export type RouteClass = (typeof RouteClass)[keyof typeof RouteClass];

export const Credential = {
  None: 'none',
  Ui: 'ui',
  DevUi: 'dev_ui',
  Render: 'render',
  Device: 'device',
  Ticket: 'ticket',
  /** A bearer that is none of 10db's: an MCP session token, a stale or foreign token. */
  Unknown: 'unknown',
} as const;
export type Credential = (typeof Credential)[keyof typeof Credential];

export const AuthVerdict = {
  Pass: 'pass',
  Unauthorized: 'unauthorized',
  NotFound: 'not_found',
} as const;
export type AuthVerdict = (typeof AuthVerdict)[keyof typeof AuthVerdict];

/** Classifies a request by exact path (one trailing slash removed); only `/app/` matches by prefix. */
export function routeClassOf(method: string, path: string): RouteClass {
  const p = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  const m = method.toUpperCase();
  if (p === '/health') return RouteClass.Health;
  if (p === '/mcp') return RouteClass.Mcp;
  if (p === '/builder/mcp') return RouteClass.BuilderMcp;
  if (p === '/screens/claim' && m === 'POST') return RouteClass.ScreensClaim;
  if (p === '/events/stream') return RouteClass.Stream;
  if (p === '/events/ticket' && m === 'POST') return RouteClass.Ticket;
  if (p === '/devices/pair' && m === 'POST') return RouteClass.Pair;
  if ((m === 'GET' || m === 'HEAD') && (p === '/app' || p.startsWith('/app/'))) {
    return RouteClass.AppStatic;
  }
  return RouteClass.Api;
}

type Row = Partial<Record<Credential, AuthVerdict>>;

const every = (verdict: AuthVerdict): Row => ({
  [Credential.None]: verdict,
  [Credential.Ui]: verdict,
  [Credential.DevUi]: verdict,
  [Credential.Render]: verdict,
  [Credential.Device]: verdict,
  [Credential.Ticket]: verdict,
  [Credential.Unknown]: verdict,
});
const pass = (...credentials: Credential[]): Row =>
  Object.fromEntries(credentials.map((c) => [c, AuthVerdict.Pass]));

const MATRIX: Record<Listener, Record<RouteClass, Row>> = {
  [Listener.Main]: {
    [RouteClass.Health]: every(AuthVerdict.Pass),
    [RouteClass.Mcp]: pass(Credential.None, Credential.Unknown),
    [RouteClass.BuilderMcp]: pass(Credential.Ui),
    [RouteClass.ScreensClaim]: pass(Credential.Ui, Credential.DevUi, Credential.Render),
    [RouteClass.Stream]: pass(Credential.Ticket),
    [RouteClass.Ticket]: pass(Credential.Ui, Credential.DevUi),
    [RouteClass.Pair]: every(AuthVerdict.NotFound),
    [RouteClass.AppStatic]: every(AuthVerdict.NotFound),
    [RouteClass.Api]: pass(Credential.Ui, Credential.DevUi, Credential.Render),
  },
  [Listener.Share]: {
    [RouteClass.Health]: every(AuthVerdict.Pass),
    [RouteClass.Mcp]: every(AuthVerdict.NotFound),
    [RouteClass.BuilderMcp]: every(AuthVerdict.NotFound),
    [RouteClass.ScreensClaim]: every(AuthVerdict.NotFound),
    [RouteClass.Stream]: pass(Credential.Ticket),
    [RouteClass.Ticket]: pass(Credential.Device),
    [RouteClass.Pair]: pass(Credential.None),
    [RouteClass.AppStatic]: pass(Credential.None),
    [RouteClass.Api]: pass(Credential.Device),
  },
};

/** The spec §4.3 table. A pass here is followed by the dev-UI and render read limits, as today. */
export function authorize(
  listener: Listener,
  route: RouteClass,
  credential: Credential,
): AuthVerdict {
  return MATRIX[listener][route][credential] ?? AuthVerdict.Unauthorized;
}
