import { LinearReporterSettings, type ProjectId } from '@10db/contracts';
import { getAppSetting, type DbReader } from '@10db/db';

/** Where a project's Linear reporter settings are stored. */
export const reporterSettingsKey = (projectId: ProjectId): string => `linear-reporter.${projectId}`;

/** A project's reporter settings; absent, or a stored value that is not the shape, reads as on. */
export function reporterSettings(db: DbReader, projectId: ProjectId): LinearReporterSettings {
  const parsed = LinearReporterSettings.safeParse(
    getAppSetting(db, reporterSettingsKey(projectId)),
  );
  return parsed.success ? parsed.data : { on: true, note: '' };
}
