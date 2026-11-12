import { isAbsolute, relative } from 'node:path';
import { SessionActivityData, type PassTurnDto } from '@10db/contracts';
import { latestTurnActivity, type DbReader } from '@10db/db';

// Workbench spec §4.3: the files a pass turn has written so far, for its live line.

/** The most files one activity row carries; a turn that writes more says this many. */
export const MAX_FILES_TOUCHED = 200;

/**
 * The files a turn has touched once a tool call wrote `written`: those before, then each new one, by
 * its path in the checkout when it is under it, else as it was named. Pure.
 */
export function filesTouched(
  before: readonly string[],
  written: readonly string[],
  checkout: string,
): string[] {
  const touched = before.slice(0, MAX_FILES_TOUCHED);
  for (const path of written) {
    if (touched.length >= MAX_FILES_TOUCHED) break;
    const inside = isAbsolute(path) ? relative(checkout, path) : path;
    const named =
      isAbsolute(path) && (inside.startsWith('..') || isAbsolute(inside)) ? path : inside;
    if (!touched.includes(named)) touched.push(named);
  }
  return touched;
}

/** The files the turn had written by its newest activity row, read back from the event log. */
export function turnFilesSoFar(
  db: DbReader,
  turn: Pick<PassTurnDto, 'id' | 'workstreamId'>,
): readonly string[] {
  const latest = latestTurnActivity(db, turn);
  if (latest === undefined) return [];
  // A row the daemon wrote, read from disk: parsed before it is trusted.
  const parsed = SessionActivityData.safeParse(latest.data);
  return parsed.success ? (parsed.data.turn?.filesTouched ?? []) : [];
}
