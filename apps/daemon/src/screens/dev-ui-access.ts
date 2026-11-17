import { RENDER_READS } from './render-access';

// Decision 2026-11-11-10db-runs-the-preview-while-a-pass-is-open: 10db's own dev UI is code a pass's
// agents may be editing, so the token Open Page hands it reads and nothing else. It is deny by
// default: a GET is allowed only when named below, every GET the daemon serves is named allowed or
// refused (`api/render-reads.test.ts` fails on one that is in neither), and every other method is refused.
// What writes or acts is done in the 10db app, over its own token.

/** The reads a screen may make, and the further database reads the dev UI's other views draw. */
export const DEV_UI_READS: readonly string[] = [
  ...RENDER_READS.map((r) => r.route),
  '/tasks/:taskId/screens',
  '/screens/:screenId',
  '/shapes/:shapeId/screens/:name',
  // A call's whole output, read from its file: the dev UI's transcript expands it as the app's does.
  '/conversations/:conversationId/items/:itemId/full',
  '/projects/:projectId/pictures',
  '/events',
  '/events/head',
  '/events/stream',
  '/projects/:projectId/shape-jev',
  '/projects/:projectId/one-way-paths',
  '/projects/:projectId/live-systems',
  '/projects/:projectId/trust-grants',
  '/projects/:projectId/network-hosts',
  '/projects/:projectId/hazard-assessment',
  '/projects/:projectId/small-proposal-limit',
  '/projects/:projectId/routing-rules',
  '/projects/:projectId/candidates',
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
  '/slack',
  '/stakeholders/timers',
  '/tasks/:taskId/question-routes',
  '/inbox/:id/compose',
  '/model-profiles',
  '/kinds',
  '/playbook',
  '/playbook/move-report',
  '/projects/:projectId/playbook',
  '/judge',
  '/judge/calls',
  '/judge/calls/page',
  '/judge/decisions',
  '/judge/models',
  '/benchmarks/status',
  '/benchmarks/models',
  '/models',
  '/models/picks',
  '/models/measures',
  '/models/offers',
  '/models/status',
  '/settings/keep-awake',
  '/settings/agent-skill',
  '/agent-skill',
  '/settings/lane-permissions',
  '/settings/self-update',
  '/decisions/:id/provenance',
  '/principles/:id/provenance',
  '/shapes/:shapeId/record',
  '/shapes/:shapeId/record/:list',
  '/shapes/:shapeId/documents/:documentId/revisions/:number',
  '/tasks/:taskId/plan-context',
  '/tasks/:taskId/session',
];

/** The GETs the dev UI may not make, with why: each writes, runs a command, or hands out a token. */
export const DEV_UI_REFUSED_READS: Readonly<Record<string, string>> = {
  '/chats/:chatId/do-it': "The Do It preview reads Your folder's changes with git.",
  '/chats/:chatId/archive-preview': "Archive's preview reads a worktree's changes with git.",
  '/conversations/:conversationId/takeover':
    "A chat's takeover is read from its folder of files, which the builder's terminal agent can write.",
  '/conversations/:conversationId/takeover/preview':
    "The takeover preview reads Your folder's changes with git.",
  '/goals/:goalId/digest': "Reading a goal's digest moves its last-opened mark, which is a write.",
  '/accounts/:accountId/identity':
    "Reading an account's identity runs a command against its login.",
  '/accounts/:accountId/signin': 'The sign-in command is for the builder, in the 10db app.',
  '/system': 'A system check runs commands on the machine.',
  '/github': 'A GitHub status check runs gh on the machine.',
  '/workstreams/:id/changes': "A lane's changes are read by running git in its copy.",
  '/workstreams/:id/skips':
    "What a lane skipped holds the commands it tried, which the preview's agent-editable code must not read.",
  '/goals/:goalId/pass-pages': "A goal's pass pages are read from its tasks' commits with git.",
  '/tasks/:taskId/turns': "A page's turns are read from its kept commits with git.",
  '/projects/:projectId/pass-start': "Start Pass's preview reads Your folder with git.",
  '/passes/:passId/tasks/:taskId/take-out': "A take-out's shared changes are read with git.",
  '/passes/:passId/close': "A pass's close lists are read with git.",
  '/passes/:passId/pull-request': "Reading a pass's pull request runs gh.",
  '/dev-ui/connection': "The dev UI's own token is for the 10db app's Open Page.",
  '/slack/members': "The workspace's people are read from Slack, which the dev UI never reaches.",
  '/settings/trust/mcp-sign-ins':
    "Sign-in rows start Codex to read each account's sign-ins, which only the 10db app does.",
  '/settings/trust': "Trust lists the plugins installed in the builder's home.",
  '/projects/:projectId/trust':
    "Trust's preview runs git in every checkout and lists the builder's home.",
  '/health': 'Open to every caller; it needs no token.',
  '/chats': "A chat is the builder's own words to an agent, kept to the 10db app.",
  '/chats/recent': "A chat is the builder's own words to an agent, kept to the 10db app.",
  '/conversations/:conversationId/files': 'The `@` list reads the checkout with git.',
  '/conversations/:conversationId/files/:fileId':
    "A picture the builder sent is the builder's own, kept to the 10db app.",
  '/projects/:projectId/session-starts': 'Start from reads the checkout with git.',
  '/projects/:projectId/folder': 'Only Sessions draws who holds Your folder, in the 10db app.',
  '/projects/:projectId/chat-models': 'Only Sessions draws it, in the 10db app.',
  '/settings/sessions': 'Only Settings draws it, in the 10db app.',
  '/settings/capacity': 'Only Settings draws it, in the 10db app.',
  '/admission': "The machine's load, free disk and lane count are for the 10db app.",
};

const PARAM = '[A-Za-z0-9_-]+';
const allowed = DEV_UI_READS.map((route) => new RegExp(`^${route.replace(/:[A-Za-z]+/g, PARAM)}$`));

/** Whether the dev UI's token may make this request: a GET of a route named as a read, nothing else. */
export function devUiMayRead(method: string, path: string): boolean {
  return method === 'GET' && allowed.some((pattern) => pattern.test(path));
}
