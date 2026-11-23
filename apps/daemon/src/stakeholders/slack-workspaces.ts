import {
  ProjectSlackSetting,
  SendState,
  SlackWorkspaces,
  type ProjectId,
  type ProjectSlackDto,
  type SlackWorkspace,
} from '@10db/contracts';
import {
  deleteContactsOutsideWorkspaces,
  getAppSetting,
  liveSendsWhere,
  setAppSetting,
  type DbReader,
  type WriteContext,
} from '@10db/db';
import { LEGACY_SLACK_BOT_ACCOUNT, type Keychain } from '../environment';
import type { StateStore } from '../events';

const WORKSPACES_SETTING = 'slack.workspaces';
const projectSetting = (projectId: ProjectId): string => `slack.${projectId}`;

/** The signed-in workspaces, from the `slack.workspaces` setting; a stored value of another shape reads as none. */
export function readSlackWorkspaces(db: DbReader): SlackWorkspace[] {
  const parsed = SlackWorkspaces.safeParse(getAppSetting(db, WORKSPACES_SETTING));
  return parsed.success ? parsed.data : [];
}

export function writeSlackWorkspaces(ctx: WriteContext, workspaces: SlackWorkspace[]): void {
  // Only the fields that are set: an absent one is not a Json value.
  setAppSetting(
    ctx,
    WORKSPACES_SETTING,
    workspaces.map((w) => ({
      teamId: w.teamId,
      teamName: w.teamName,
      ...(w.botUserId === undefined ? {} : { botUserId: w.botUserId }),
      ...(w.botName === undefined ? {} : { botName: w.botName }),
      ...(w.botSince === undefined ? {} : { botSince: w.botSince }),
    })),
  );
}

/** Adds the workspace, or renames its entry; its bot fields are kept (`recordBot` writes them). */
export function saveSlackWorkspace(
  ctx: WriteContext,
  workspace: { teamId: string; teamName: string },
): void {
  const all = readSlackWorkspaces(ctx.tx);
  const known = all.some((w) => w.teamId === workspace.teamId);
  writeSlackWorkspaces(
    ctx,
    known
      ? all.map((w) => (w.teamId === workspace.teamId ? { ...w, teamName: workspace.teamName } : w))
      : [...all, workspace],
  );
}

/** Drops the entry, bot record included. */
export function removeSlackWorkspace(ctx: WriteContext, teamId: string): void {
  writeSlackWorkspaces(
    ctx,
    readSlackWorkspaces(ctx.tx).filter((w) => w.teamId !== teamId),
  );
}

/** The stored binding as written, signed in or not; null for no setting or Off. */
export function boundTeam(db: DbReader, projectId: ProjectId): string | null {
  const stored = ProjectSlackSetting.safeParse(getAppSetting(db, projectSetting(projectId)));
  return stored.success ? stored.data.teamId : null;
}

/** The effective binding: the stored workspace while it is signed in; no setting, null, or signed out is Off. */
export function projectSlack(db: DbReader, projectId: ProjectId): ProjectSlackDto {
  const teamId = boundTeam(db, projectId);
  const workspace = readSlackWorkspaces(db).find((w) => w.teamId === teamId);
  // What is out counts on every path, Off and a signed-out workspace included: a change takes it back.
  const out = liveSendsWhere(db, { projectId }).filter(
    (s) => s.state === SendState.Sending || s.state === SendState.Sent,
  ).length;
  if (workspace === undefined) return { teamId: null, teamName: null, out };
  return { teamId: workspace.teamId, teamName: workspace.teamName, out };
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
