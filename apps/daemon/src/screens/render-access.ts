// Shape spec §5.5. A screen is drawn by the app's own window under a render token, and the daemon
// holds that token to reading what the screen shows. The 2026-11-02 design review ran the UI through
// a proxy that allowed only GET and refused GET /goals/:id/digest, because that read moves a goal's
// last-opened mark. This is that proxy as a rule inside the daemon. The rule is that a screen changes
// nothing, not that no read may touch git: of the other GETs that are not plain reads, one is allowed
// because it writes nothing and Plan's screen needs it (see RENDER_READS), and the rest are refused.
//
// Every GET the daemon serves is named below, allowed or refused, and a test fails for one that is
// in neither, so a new route has to be decided before a screen can reach it.

/**
 * A route a screen may read. None writes anything. Each is a database read, but for `/shapes/:shapeId`:
 * its view also lists the repository's tracked files with `git ls-files`, a read of the checkout.
 */
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
  { route: '/projects/:projectId/proposals' },
  // Factory draws it: cards per task and minutes work waited on a person, per day. Database reads only.
  { route: '/projects/:projectId/human-touch' },
];

/** A GET a screen may not read, with why. A route nothing draws is refused as well: less to reach. */
export const RENDER_REFUSED_READS: Readonly<Record<string, string>> = {
  '/goals/:goalId/digest':
    "Reading a goal's digest moves the goal's last-opened mark, which is a write.",
  '/accounts/:accountId/identity':
    "Reading an account's identity runs a command against the account's login.",
  '/accounts/:accountId/signin':
    "The sign-in command is for the builder's own terminal, not for a screen; a screen can't start a sign-in either (POST /accounts/:accountId/connect).",
  '/system':
    'A system check probes the machine and runs commands; ?recheck=1 runs them again on every read.',
  '/workstreams/:id/changes':
    "A lane's changes are read by running git in its copy, and a screen draws without them.",
  '/health': 'Open to every caller; it needs no token.',
  '/shapes/:shapeId/screens/:name':
    "A kept screenshot is for the conversation's transcript, not for a screen.",
  '/tasks/:taskId/thread':
    "A task's thread is the builder's own words to an agent, and no screen Plan draws shows it.",
  '/tasks/:taskId/screens':
    "A picture of the builder's app is for the UI Workbench and the drawer, not for a screen.",
  '/screens/:screenId':
    "A picture of the builder's app is for the UI Workbench and the drawer, not for a screen.",
  '/projects/:projectId/pictures':
    "The browser for pictures and its sign-in are Settings' own line, and no screen Plan draws shows them.",
  '/tasks/:taskId/thread/pictures/:fileId':
    "A picture pasted into a task's thread is for that thread, not for a screen.",
  '/events': 'The event log is not a screen; the window draws once and does not follow it.',
  '/events/head': 'The event log is not a screen; the window draws once and does not follow it.',
  '/events/stream':
    'The live stream is not a screen; the window draws once and does not follow it.',
  '/projects/:projectId/shape-jev': 'No screen draws a setting.',
  '/projects/:projectId/one-way-paths': 'No screen draws a setting.',
  '/projects/:projectId/network-hosts': 'No screen draws a setting.',
  '/projects/:projectId/hazard-assessment': 'No screen draws a setting.',
  '/projects/:projectId/small-proposal-limit': 'No screen draws a setting.',
  '/projects/:projectId/team': 'No screen draws a setting.',
  '/projects/:projectId/routing-rules': 'No screen draws a setting.',
  '/projects/:projectId/candidates': 'No screen draws what Run next would pick.',
  '/passes/:passId': 'Only the UI Workbench draws a pass, and it is not a screen.',
  '/passes': 'Only the UI Workbench draws a pass, and it is not a screen.',
  '/pass-turns/:turnId/activity': 'Only the UI Workbench draws a pass, and it is not a screen.',
  '/goals/:goalId/pass-pages': "A goal's pass pages are read from its tasks' commits with git.",
  '/tasks/:taskId/turns':
    "A page's turns list the files each changed, read from its kept commits with git.",
  '/projects/:projectId/pass-start':
    "Start Pass's preview reads Your folder with git: its changed files, its branch and the base.",
  '/passes/:passId/tasks/:taskId/take-out':
    "A take-out's shared changes are read by running git in Your folder, and no screen draws them.",
  '/passes/:passId/close':
    "A pass's close lists are read by running git in Your folder, and only the UI Workbench draws them.",
  '/passes/:passId/pull-request':
    "Reading a pass's pull request asks gh whether it is signed in, and only the UI Workbench draws it.",
  '/shape-measures': 'No screen draws a measure.',
  '/accounts': 'No screen draws an account.',
  '/accounts/pauses': 'No screen draws an account.',
  '/accounts/connecting': 'No screen draws an account.',
  '/accounts/:accountId/usage': 'No screen draws an account.',
  '/personas': 'No screen draws a setting.',
  '/people': 'No screen draws a setting.',
  '/slack': 'No screen draws a setting.',
  '/slack/members': "The workspace's people are read from Slack, and no screen draws them.",
  '/stakeholders/timers': 'No screen draws a setting.',
  '/tasks/:taskId/question-routes': 'No screen draws who answers a task.',
  '/inbox/:id/compose': "A drafted message is for the builder's own window, not for a screen.",
  '/model-profiles': 'No screen draws a setting.',
  '/model-settings': 'No screen draws a setting.',
  '/projects/:projectId/model-settings': 'No screen draws a setting.',
  '/judge': 'No screen draws a setting.',
  '/judge/calls': 'No screen draws a setting.',
  '/benchmarks/status': 'No screen draws a benchmark.',
  '/benchmarks/models': 'No screen draws a benchmark.',
  '/models': 'No screen draws the model list.',
  '/models/picks': 'No screen draws the model list.',
  '/models/offers': 'No screen draws the model list.',
  '/models/status': 'No screen draws the model list.',
  '/settings/keep-awake': 'No screen draws a setting.',
  '/settings/lane-permissions': 'No screen draws a setting.',
  '/settings/trust': 'No screen draws a setting.',
  '/projects/:projectId/trust': 'No screen draws a setting.',
  '/settings/self-update': 'No screen draws a setting.',
  '/projects/:projectId/knowledge': 'Only the Knowledge view draws it, and it is not a screen.',
  '/dev-ui/connection': "The dev UI's token is for the app's Open Page, not for a screen.",
  '/decisions/:id/provenance': 'Only the Knowledge view draws it, and it is not a screen.',
  '/principles/:id/provenance': 'Only the Knowledge view draws it, and it is not a screen.',
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
