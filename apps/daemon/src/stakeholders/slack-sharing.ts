import { ProjectSlackSharingDto, type ProjectId } from '@10db/contracts';
import { getAppSetting, setAppSetting, type DbReader, type WriteContext } from '@10db/db';

const sharingSetting = (projectId: ProjectId): string => `slack-sharing.${projectId}`;

const OFF: ProjectSlackSharingDto = {
  enabled: false,
  teamId: null,
  channelId: null,
  channelName: null,
};

/** The project's pictures-to-Slack setting; no setting, or one of another shape, is off with no channel. */
export function readSlackSharing(db: DbReader, projectId: ProjectId): ProjectSlackSharingDto {
  const stored = ProjectSlackSharingDto.safeParse(getAppSetting(db, sharingSetting(projectId)));
  return stored.success ? stored.data : OFF;
}

export function writeSlackSharing(
  ctx: WriteContext,
  projectId: ProjectId,
  setting: ProjectSlackSharingDto,
): void {
  setAppSetting(ctx, sharingSetting(projectId), {
    ...setting,
    enabledAt: setting.enabledAt ?? null,
  });
}

/** A workspace change takes the channel back: it belongs to the workspace it was picked in. */
export function dropSharingChannelOutside(
  ctx: WriteContext,
  projectId: ProjectId,
  teamId: string | null,
): void {
  const now = readSlackSharing(ctx.tx, projectId);
  if (now.channelId === null || now.teamId === teamId) return;
  writeSlackSharing(ctx, projectId, { ...now, teamId: null, channelId: null, channelName: null });
}
