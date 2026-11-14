import { cpSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { DB_MIGRATIONS_DIR } from './index';

const Journal = z.looseObject({ entries: z.array(z.looseObject({ tag: z.string() })) });

/**
 * The migrations that came before the one named by `tag`: a copy of the shipped folder inside `dir`
 * with its journal cut short. A migration test migrates a database through this folder, seeds it, and
 * then migrates it forward with the shipped one.
 */
export function migrationsBefore(dir: string, tag: string): string {
  const before = join(dir, 'before');
  cpSync(DB_MIGRATIONS_DIR, before, { recursive: true });
  const journalPath = join(before, 'meta/_journal.json');
  // A journal this function just copied from the shipped migrations; the shape is known.
  const journal = Journal.parse(JSON.parse(readFileSync(journalPath, 'utf8')));
  const cut = journal.entries.findIndex((e) => e.tag === tag);
  const keep = new Set(journal.entries.slice(0, cut).map((e) => e.tag));
  journal.entries = journal.entries.filter((e) => keep.has(e.tag));
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  for (const file of readdirSync(before)) {
    if (file.endsWith('.sql') && !keep.has(file.slice(0, -'.sql'.length)))
      rmSync(join(before, file));
  }
  return before;
}
