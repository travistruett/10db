import { LinearReporterSettings, type ProjectId } from '@10db/contracts';
import { getAppSetting, type DbReader } from '@10db/db';

/** Where a project's Linear reporter settings are stored. */
export const reporterSettingsKey = (projectId: ProjectId): string => `linear-reporter.${projectId}`;

/**
 * A project's reporter settings. Absent reads as on: the builder turns reporting off, not on. A stored value
 * that is not the shape reads as off, as a trust switch does, so a damaged setting never posts.
 */
export function reporterSettings(db: DbReader, projectId: ProjectId): LinearReporterSettings {
  const stored = getAppSetting(db, reporterSettingsKey(projectId));
  if (stored === undefined) return { on: true, note: '' };
  const parsed = LinearReporterSettings.safeParse(stored);
  return parsed.success ? parsed.data : { on: false, note: '' };
}
