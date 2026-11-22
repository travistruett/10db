import {
  ProjectSlackSetting,
  SlackWorkspaces,
  type ProjectId,
  type ProjectSlackDto,
  type SlackWorkspace,
} from '@10db/contracts';
import {
  deleteContactsOutsideWorkspaces,
  getAppSetting,
  setAppSetting,
  type DbReader,
  type WriteContext,
} from '@10db/db';
import { LEGACY_SLACK_BOT_ACCOUNT, slackBotAccount, type Keychain } from '../environment';
import type { StateStore } from '../events';

const WORKSPACES_SETTING = 'slack.workspaces';
const projectSetting = (projectId: ProjectId): string => `slack.${projectId}`;

/** The signed-in workspaces, from the `slack.workspaces` setting; a stored value of another shape reads as none. */
export function readSlackWorkspaces(db: DbReader): SlackWorkspace[] {
  const parsed = SlackWorkspaces.safeParse(getAppSetting(db, WORKSPACES_SETTING));
  return parsed.success ? parsed.data : [];
}

export function writeSlackWorkspaces(ctx: WriteContext, workspaces: SlackWorkspace[]): void {
  setAppSetting(ctx, WORKSPACES_SETTING, workspaces);
}

/** The token of the signed-in workspace, or null with none. Reads the Keychain without blocking the loop. */
export function slackTokenReader(
  state: StateStore,
  keychain: Keychain,
): () => Promise<string | null> {
  return async () => {
    const workspace = readSlackWorkspaces(state.db)[0];
    return workspace === undefined ? null : keychain.readAsync(slackBotAccount(workspace.teamId));
  };
}

/** What Slack is for a project: its stored choice, else the only workspace while there is exactly one. */
export function projectSlack(db: DbReader, projectId: ProjectId): ProjectSlackDto {
  const workspaces = readSlackWorkspaces(db);
  const stored = ProjectSlackSetting.safeParse(getAppSetting(db, projectSetting(projectId)));
  const auto = !stored.success;
  const teamId = stored.success
    ? stored.data.teamId
    : workspaces.length === 1
      ? (workspaces[0]?.teamId ?? null)
      : null;
  const workspace = workspaces.find((w) => w.teamId === teamId);
  // A stored workspace that is no longer signed in sends nowhere.
  return workspace === undefined
    ? { teamId: null, teamName: null, auto }
    : { teamId: workspace.teamId, teamName: workspace.teamName, auto };
}

export function setProjectSlack(
  ctx: WriteContext,
  projectId: ProjectId,
  teamId: string | null,
): void {
  setAppSetting(ctx, projectSetting(projectId), { teamId });
}

/**
 * At startup, once: an earlier 10db kept the Slack token under one name for every workspace. When that item is
 * found, the Slack contact of every person whose workspace is not signed in is deleted, then the item. With no
 * such item nothing is deleted. A Keychain that can't be read (locked, timed out) leaves both for the next start.
 */
export function cleanUpSlackSignIns(deps: {
  readonly state: StateStore;
  readonly keychain: Keychain;
  readonly log: { warn(fields: object, message: string): void };
}): void {
  let legacy: string | null;
  try {
    legacy = deps.keychain.read(LEGACY_SLACK_BOT_ACCOUNT);
  } catch (error) {
    deps.log.warn({ error: errorName(error) }, 'the old Slack token could not be looked for');
    return;
  }
  if (legacy === null) return;
  const signedIn = readSlackWorkspaces(deps.state.db).map((w) => w.teamId);
  deps.state.write((ctx) => {
    deleteContactsOutsideWorkspaces(ctx, signedIn);
  });
  try {
    deps.keychain.remove(LEGACY_SLACK_BOT_ACCOUNT);
  } catch (error) {
    deps.log.warn({ error: errorName(error) }, 'the old Slack token could not be removed');
  }
}

const errorName = (error: unknown): string => (error instanceof Error ? error.name : 'Error');
