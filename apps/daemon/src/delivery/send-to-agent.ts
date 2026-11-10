import type { TaskMessageId } from '@10db/contracts';
import { getAppSetting, setAppSetting, type DbReader, type WriteContext } from '@10db/db';
import { z } from 'zod';

// Workbench spec §8.1, §8.3, D19: a failed check, a broken preview and a review finding are offered
// with Send to Agent and never sent by themselves. A thread notice offered so keeps the text Send to
// Agent sends, by the notice's id, beside the thread; a notice with none offers nothing.

const key = (id: TaskMessageId): string => `send_to_agent.${id}`;

/** Offers thread notice `id` with Send to Agent, which will send `text` as the builder's message. */
export function offerToAgent(ctx: WriteContext, id: TaskMessageId, text: string): void {
  setAppSetting(ctx, key(id), text);
}

/** The text Send to Agent sends for thread notice `id`; null when it offers none. */
export function offeredText(db: DbReader, id: TaskMessageId): string | null {
  // Read from the database: parsed, as at every boundary.
  const stored = z
    .string()
    .min(1)
    .safeParse(getAppSetting(db, key(id)));
  return stored.success ? stored.data : null;
}
