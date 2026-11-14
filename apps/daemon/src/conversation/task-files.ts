import { join } from 'node:path';
import type { TaskId } from '@10db/contracts';

// Workbench spec §4.3, §11. Where the daemon keeps a task's pasted pictures; what a picture must be,
// and how it is kept, is the conversation module's.

/** Where a task's pasted pictures are kept: in the data directory, outside every checkout. */
export const taskFilesDir = (dataDir: string, taskId: TaskId): string =>
  join(dataDir, 'tasks', taskId, 'files');
