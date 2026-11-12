import type { PassViewDto } from '@10db/contracts';
import { listLivePasses, type DbReader } from '@10db/db';
import { passView } from './view';

// Workbench spec §4.1, §5.4: the passes the Workbench shows, one per project at most but for a closed
// pass whose work is not in the base yet, which shows beside its project's next one.

/** Every live pass, oldest first, each as `GET /passes/:passId` reads it. Reads only. */
export function livePassViews(db: DbReader): PassViewDto[] {
  return listLivePasses(db).map((pass) => passView(db, pass.id));
}
