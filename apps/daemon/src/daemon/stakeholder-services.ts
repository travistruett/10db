import {
  ConflictError,
  InvalidError,
  type ProjectId,
  type ProjectIntegrationsDto,
  type SlackConnectionDto,
  type SlackMemberDto,
} from '@10db/contracts';
import {
  dropPendingLinearPosts,
  getInboxItem,
  getProject,
  getPerson,
  getStakeholderTimers,
  questionRoutesForTask,
  removePerson,
  setAppSetting,
  setStakeholderTimers,
  updatePerson,
} from '@10db/db';
import type { ApiServices } from '../api';
import type { Clock } from '../clock';
import { KeychainError, slackBotAccount, type Keychain } from '../environment';
import type { StateStore } from '../events';
import { createSlackClient, SlackError, type SlackClient } from '../slack';
import {
  previewDraft,
  projectSlack,
  readSlackWorkspaces,
  setProjectSlack,
  writeSlackWorkspaces,
  type SlackConnection,
  type StakeholderSends,
} from '../stakeholders';
import {
  reporterBlockedBy,
  reporterSettings,
  reporterSettingsKey,
  type LinearImport,
} from '../linear';

/** The stakeholder side of the HTTP API: the Slack connection, people, timers, routes and sends. */
export type StakeholderApiServices = Pick<
  ApiServices,
  | 'slackStatus'
  | 'setSlackToken'
  | 'removeSlackToken'
  | 'projectIntegrations'
  | 'importFromLinear'
  | 'setLinearReporter'
  | 'setProjectIntegrations'
  | 'listSlackMembers'
  | 'updatePerson'
  | 'removePerson'
  | 'getStakeholderTimers'
  | 'setStakeholderTimers'
  | 'questionRoutes'
  | 'sendInbox'
  | 'askSomeone'
  | 'takeBack'
  | 'keepWaiting'
  | 'composeFor'
>;

/** How long the workspace's member list is kept before it is read again. */
const MEMBERS_TTL_MS = 10 * 60_000;
const MEMBER_PAGES = 20;
const CHECK_TIMEOUT_MS = 15_000;

/** Why Slack turned a token down, in the builder's words. */
function refusalWords(error: SlackError): string {
  switch (error.code) {
    case 'invalid_auth':
    case 'not_authed':
    case 'token_revoked':
    case 'account_inactive':
      return "Slack does not accept that token. Copy the Bot User OAuth Token (it starts with xoxb-) from the app's OAuth & Permissions page.";
    default:
      return `Slack answered "${error.code}" when the token was checked`;
  }
}

async function keychainConflict<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof KeychainError) throw new ConflictError(error.message);
    throw error;
  }
}

export function createStakeholderApiServices(deps: {
  readonly state: StateStore;
  readonly keychain: Keychain;
  /** The client the daemon talks to Slack with; null when Slack is off. */
  readonly slack: SlackClient | null;
  readonly sends: StakeholderSends;
  readonly connection: SlackConnection;
  readonly clock: Clock;
  readonly fetch: typeof fetch;
  /** Starts the reply watch again after a new token was saved. */
  readonly reconnect: () => Promise<void>;
  /** The login `gh` is signed in as, from its last check; null when signed out. */
  readonly githubLogin: () => Promise<string | null>;
  readonly linear: LinearImport;
}): StakeholderApiServices {
  const integrationsOf = async (projectId: ProjectId): Promise<ProjectIntegrationsDto> => {
    getProject(deps.state.db, projectId);
    return {
      github: { login: await deps.githubLogin() },
      slack: projectSlack(deps.state.db, projectId),
      linear: {
        ...reporterSettings(deps.state.db, projectId),
        blockedBy: reporterBlockedBy(deps.state.db, projectId),
      },
    };
  };

  let members: { readonly at: number; readonly list: SlackMemberDto[] } | null = null;

  async function allMembers(client: SlackClient): Promise<SlackMemberDto[]> {
    const now = deps.clock.now().getTime();
    if (members && now - members.at < MEMBERS_TTL_MS) return members.list;
    const list: SlackMemberDto[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MEMBER_PAGES; page += 1) {
      const next = await client.listMembers(cursor);
      list.push(...next.members);
      if (next.nextCursor === null) break;
      cursor = next.nextCursor;
    }
    members = { at: now, list };
    return list;
  }

  return {
    slackStatus: (): SlackConnectionDto => deps.connection.get(),

    async setSlackToken(input) {
      // The token is tried on a client of its own, so a refused one is never kept.
      const checker = createSlackClient({
        fetch: deps.fetch,
        token: () => Promise.resolve(input.token),
        clock: deps.clock,
        timeoutMs: CHECK_TIMEOUT_MS,
      });
      let identity;
      try {
        identity = await checker.authTest();
      } catch (error) {
        if (!(error instanceof SlackError)) throw error;
        if (error.code === 'unreachable' || error.code === 'timeout')
          throw new ConflictError(
            'Slack could not be reached. Check the connection and try again.',
          );
        throw new InvalidError(refusalWords(error));
      }
      // Written and read back under the workspace's own entry before anything else changes.
      await keychainConflict(() => {
        deps.keychain.write(slackBotAccount(identity.teamId), input.token);
      });
      // One workspace is signed in at a time: a token for another one replaces it.
      const replaced = readSlackWorkspaces(deps.state.db).filter(
        (w) => w.teamId !== identity.teamId,
      );
      deps.state.write((ctx) => {
        writeSlackWorkspaces(ctx, [{ teamId: identity.teamId, teamName: identity.teamName }]);
      });
      await keychainConflict(() => {
        for (const old of replaced) deps.keychain.remove(slackBotAccount(old.teamId));
      });
      members = null;
      deps.connection.set('connected', { identity });
      await deps.reconnect();
      return deps.connection.get();
    },

    projectIntegrations: integrationsOf,
    importFromLinear: (projectId) => deps.linear.startImport(projectId),

    setLinearReporter: async (projectId, input) => {
      getProject(deps.state.db, projectId);
      deps.state.write((ctx) => {
        setAppSetting(ctx, reporterSettingsKey(projectId), input);
        // Setting writes emit no event, so the owed updates are dropped here.
        if (!input.on) dropPendingLinearPosts(ctx, { projectId });
      });
      return integrationsOf(projectId);
    },

    async setProjectIntegrations(projectId, input) {
      getProject(deps.state.db, projectId);
      const { teamId } = input.slack;
      // Only a signed-in workspace can be chosen; null is the builder's "off".
      if (teamId !== null && !readSlackWorkspaces(deps.state.db).some((w) => w.teamId === teamId))
        throw new InvalidError('That Slack workspace is not signed in');
      deps.state.write((ctx) => {
        setProjectSlack(ctx, projectId, teamId);
      });
      return integrationsOf(projectId);
    },

    async removeSlackToken() {
      const signedIn = readSlackWorkspaces(deps.state.db);
      await keychainConflict(() => {
        for (const workspace of signedIn) deps.keychain.remove(slackBotAccount(workspace.teamId));
      });
      deps.state.write((ctx) => {
        writeSlackWorkspaces(ctx, []);
      });
      members = null;
      deps.connection.set('none');
      return deps.connection.get();
    },

    async listSlackMembers(query) {
      if (deps.slack === null) throw new ConflictError('Slack is not connected');
      const wanted = query.trim().toLowerCase();
      const list = await allMembers(deps.slack);
      return wanted === ''
        ? list
        : list.filter((m) =>
            [m.name, m.realName, m.email ?? '', m.title ?? ''].some((field) =>
              field.toLowerCase().includes(wanted),
            ),
          );
    },

    updatePerson: (id, input) => deps.state.write((ctx) => updatePerson(ctx, id, input)),
    removePerson: (id) => {
      deps.state.write((ctx) => {
        removePerson(ctx, id);
      });
    },
    getStakeholderTimers: () => getStakeholderTimers(deps.state.db),
    setStakeholderTimers: (input) => deps.state.write((ctx) => setStakeholderTimers(ctx, input)),
    questionRoutes: (taskId) => questionRoutesForTask(deps.state.db, taskId),

    sendInbox: (id, input) => deps.sends.send(id, input),
    askSomeone(id, input) {
      deps.sends.askSomeone(id, input);
      return getInboxItem(deps.state.db, id);
    },
    async takeBack(id) {
      await deps.sends.takeBack(id);
      return getInboxItem(deps.state.db, id);
    },
    keepWaiting(id) {
      deps.sends.keepWaiting(id);
      return getInboxItem(deps.state.db, id);
    },
    composeFor: (id, personIds) =>
      previewDraft(
        deps.state.db,
        getInboxItem(deps.state.db, id),
        personIds.map((personId) => getPerson(deps.state.db, personId)),
      ),
  };
}
