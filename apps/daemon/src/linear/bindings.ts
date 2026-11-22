import { LinearBinding, type ProjectId } from '@10db/contracts';
import { getAppSetting, type DbReader } from '@10db/db';

/** A project's stored Linear binding, or null when it has none or the stored value is not one. */
export function linearBindingOf(db: DbReader, projectId: ProjectId): LinearBinding | null {
  const parsed = LinearBinding.safeParse(getAppSetting(db, `linear.${projectId}`));
  return parsed.success ? parsed.data : null;
}
