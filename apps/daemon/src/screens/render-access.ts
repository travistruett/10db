// Shape spec §5.5. A screen is drawn by the app's own window under a render token, and the daemon
// holds that token to reading what the screen shows. The 2026-11-02 design review ran the UI through
// a proxy that allowed only GET and refused GET /goals/:id/digest, because that read moves a goal's
// last-opened mark. This is that proxy as a rule inside the daemon, with the other GETs that are not
// plain reads found and refused too.
//
// Every GET the daemon serves is named below, allowed or refused, and a test fails for one that is
// in neither, so a new route has to be decided before a screen can reach it.

/** A route a screen may read. Each is a plain database read: nothing it answers writes a row. */
export const RENDER_READS: readonly { readonly route: string }[] = [
  { route: '/projects' },
  { route: '/projects/:projectId/tasks' },
  { route: '/projects/:projectId/batches' },
  { route: '/projects/:projectId/goals' },
  { route: '/projects/:projectId/shapes' },
  { route: '/projects/:projectId/board-columns' },
  { route: '/goals/:goalId' },
  { route: '/goals/:goalId/shape' },
  { route: '/tasks/:taskId/shape' },
  { route: '/tasks/:taskId/step-plan' },
  { route: '/shapes/:shapeId' },
  { route: '/flows' },
  { route: '/workstreams' },
  { route: '/inbox' },
];

/** A GET a screen may not read, with why. A route nothing draws is refused as well: less to reach. */
export const RENDER_REFUSED_READS: Readonly<Record<string, string>> = {
  '/goals/:goalId/digest':
    "Reading a goal's digest moves the goal's last-opened mark, which is a write.",
  '/accounts/:accountId/identity':
    "Reading an account's identity runs a command against the account's login.",
  '/accounts/:accountId/signin': "A sign-in is for the builder's own terminal, not for a screen.",
  '/system':
    'A system check probes the machine and runs commands; ?recheck=1 runs them again on every read.',
  '/workstreams/:id/changes':
    "A lane's changes are read by running git in its checkout; a screen runs no command.",
  '/health': 'Open to every caller; it needs no token.',
  '/shapes/:shapeId/screens/:name':
    "A kept screenshot is for the conversation's transcript, not for a screen.",
  '/events': 'The event log is not a screen; the window draws once and does not follow it.',
  '/events/head': 'The event log is not a screen; the window draws once and does not follow it.',
  '/events/stream':
    'The live stream is not a screen; the window draws once and does not follow it.',
  '/projects/:projectId/shape-jev': 'No screen draws a setting.',
  '/projects/:projectId/one-way-paths': 'No screen draws a setting.',
  '/projects/:projectId/network-hosts': 'No screen draws a setting.',
  '/projects/:projectId/team': 'No screen draws a setting.',
  '/projects/:projectId/routing-rules': 'No screen draws a setting.',
  '/projects/:projectId/candidates': 'No screen draws what Run next would pick.',
  '/shape-measures': 'No screen draws a measure.',
  '/accounts': 'No screen draws an account.',
  '/accounts/pauses': 'No screen draws an account.',
  '/accounts/:accountId/usage': 'No screen draws an account.',
  '/personas': 'No screen draws a setting.',
  '/people': 'No screen draws a setting.',
  '/model-profiles': 'No screen draws a setting.',
  '/judge': 'No screen draws a setting.',
  '/judge/calls': 'No screen draws a setting.',
  '/benchmarks/status': 'No screen draws a benchmark.',
  '/benchmarks/models': 'No screen draws a benchmark.',
  '/settings/keep-awake': 'No screen draws a setting.',
  '/settings/lane-permissions': 'No screen draws a setting.',
};

const PARAM = '[A-Za-z0-9_-]+';

const allowed: readonly RegExp[] = RENDER_READS.map(
  ({ route }) => new RegExp(`^${route.replace(/:[A-Za-z]+/g, PARAM)}$`),
);

/**
 * Whether a render token may make this request: a GET of a route a screen shows, by its exact path
 * (the query is not part of it). Any other method, any other path and any near miss is refused.
 */
export function renderMayRead(method: string, path: string): boolean {
  return method === 'GET' && allowed.some((pattern) => pattern.test(path));
}
