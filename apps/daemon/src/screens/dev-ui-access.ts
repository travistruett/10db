import { RENDER_READS } from './render-access';

// Decision 2026-11-11-10db-runs-the-preview-while-a-pass-is-open: 10db's own dev UI is code a pass's
// agents may be editing, so the token Open Page hands it reads and nothing else. It is deny by
// default: a GET is allowed only when named below, every GET the daemon serves is named allowed or
// refused (`api/render-reads.test.ts` fails on one that is in neither), and every other method is refused.
// What writes or acts is done in the 10db app, over its own token.

/** The reads a screen may make, and the further database reads the dev UI's other views draw. */
export const DEV_UI_READS: readonly string[] = [
  ...RENDER_READS.map((r) => r.route),
  '/tasks/:taskId/thread',
  '/tasks/:taskId/screens',
  '/screens/:screenId',
  '/tasks/:taskId/thread/pictures/:fileId',
  '/shapes/:shapeId/screens/:name',
  '/projects/:projectId/pictures',
  '/events',
  '/events/head',
  '/events/stream',
  '/projects/:projectId/shape-jev',
  '/projects/:projectId/one-way-paths',
  '/projects/:projectId/network-hosts',
  '/projects/:projectId/hazard-assessment',
  '/projects/:projectId/small-proposal-limit',
  '/projects/:projectId/team',
  '/projects/:projectId/routing-rules',
  '/projects/:projectId/candidates',
  '/projects/:projectId/model-settings',
  '/projects/:projectId/knowledge',
  '/passes',
  '/passes/:passId',
  '/pass-turns/:turnId/activity',
  '/shape-measures',
  '/accounts',
  '/accounts/pauses',
  '/accounts/connecting',
  '/accounts/:accountId/usage',
  '/personas',
  '/people',
  '/model-profiles',
  '/model-settings',
  '/judge',
  '/judge/calls',
  '/benchmarks/status',
  '/benchmarks/models',
  '/models',
  '/models/offers',
  '/models/status',
  '/settings/keep-awake',
  '/settings/lane-permissions',
  '/settings/trust',
  '/projects/:projectId/trust',
  '/settings/self-update',
  '/decisions/:id/provenance',
  '/principles/:id/provenance',
];

/** The GETs the dev UI may not make, with why: each writes, runs a command, or hands out a token. */
export const DEV_UI_REFUSED_READS: Readonly<Record<string, string>> = {
  '/goals/:goalId/digest': "Reading a goal's digest moves its last-opened mark, which is a write.",
  '/accounts/:accountId/identity':
    "Reading an account's identity runs a command against its login.",
  '/accounts/:accountId/signin': 'The sign-in command is for the builder, in the 10db app.',
  '/system': 'A system check runs commands on the machine.',
  '/workstreams/:id/changes': "A lane's changes are read by running git in its copy.",
  '/goals/:goalId/pass-pages': "A goal's pass pages are read from its tasks' commits with git.",
  '/tasks/:taskId/turns': "A page's turns are read from its kept commits with git.",
  '/projects/:projectId/pass-start': "Start Pass's preview reads Your folder with git.",
  '/passes/:passId/tasks/:taskId/take-out': "A take-out's shared changes are read with git.",
  '/passes/:passId/close': "A pass's close lists are read with git.",
  '/passes/:passId/pull-request': "Reading a pass's pull request runs gh.",
  '/dev-ui/connection': "The dev UI's own token is for the 10db app's Open Page.",
  '/health': 'Open to every caller; it needs no token.',
};

const PARAM = '[A-Za-z0-9_-]+';
const allowed = DEV_UI_READS.map((route) => new RegExp(`^${route.replace(/:[A-Za-z]+/g, PARAM)}$`));

/** Whether the dev UI's token may make this request: a GET of a route named as a read, nothing else. */
export function devUiMayRead(method: string, path: string): boolean {
  return method === 'GET' && allowed.some((pattern) => pattern.test(path));
}
