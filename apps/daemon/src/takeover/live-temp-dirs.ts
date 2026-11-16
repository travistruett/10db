import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ConversationId, ConversationState } from '@10db/contracts';
import { getConversation, type DbReader } from '@10db/db';
import { readTakeoverRecord, takeoverFolderOf, TAKEOVERS } from './files';

/**
 * The temp dirs the servers of every chat still in the builder's terminal use, for the startup sweep to leave alone.
 * `takeover.json` is written by a folder the terminal's agent can write, so a chat counts only while its row says it
 * is taken over, and the sweep itself honours a path only under the root and with the name it removes.
 */
export function liveTakeoverTempDirs(db: DbReader, dataDir: string): Set<string> {
  const kept = new Set<string>();
  let names: string[];
  try {
    names = readdirSync(join(dataDir, TAKEOVERS));
  } catch {
    return kept;
  }
  for (const name of names) {
    const id = ConversationId.safeParse(name);
    if (!id.success) continue;
    let state: ConversationState | null;
    try {
      state = getConversation(db, id.data).state;
    } catch {
      continue;
    }
    if (state !== ConversationState.TakenOver) continue;
    for (const dir of readTakeoverRecord(takeoverFolderOf(dataDir, id.data))?.tempDirs ?? [])
      kept.add(dir);
  }
  return kept;
}
