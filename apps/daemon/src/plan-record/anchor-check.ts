import { AnchorResult, type PlanAnchor, type TaskId, type WorkstreamId } from '@10db/contracts';
import {
  getShapeEntry,
  getTaskContext,
  insertAnchorChecks,
  listAnchorChecks,
  type NewAnchorCheck,
} from '@10db/db';
import type { StateStore } from '../events';
import type { Git } from '../git';
import { locateAnchor } from './anchors';

// Checking the code anchors a task cites against the base its workstream reads, before a session
// starts. A check is kept per workstream, base commit and fact version, so it runs again only when the
// base moves or a re-import versions a cited fact. Nothing it can't read is ever current.

/** The largest file an anchor is looked for in; a bigger one is not checked. */
export const ANCHOR_FILE_MAX_BYTES = 4 * 1024 * 1024;

type FileRead =
  Awaited<ReturnType<Git['fileAt']>> | { readonly kind: 'error'; readonly note: string };

/** The first line of a thrown error, for the check's note. */
function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const line = text.split('\n')[0]?.trim() ?? '';
  return line === '' ? 'git could not read the commit' : line;
}

/**
 * Checks the task's cited anchors that this workstream has not checked at `rev` for the fact's
 * current version, and keeps the results in one write. Answers how many rows it wrote.
 */
export async function checkTaskAnchors(
  deps: { readonly git: Git; readonly state: StateStore },
  input: {
    readonly workstreamId: WorkstreamId;
    readonly taskId: TaskId;
    readonly repo: string;
    readonly rev: string;
  },
): Promise<number> {
  const db = deps.state.db;
  const context = getTaskContext(db, input.taskId);
  if (context === undefined) return 0;
  const done = new Set(
    listAnchorChecks(db, input.workstreamId, input.rev).map((c) =>
      JSON.stringify([c.entryKey, c.entryVersion, c.anchorIndex]),
    ),
  );
  const todo: { key: string; version: number; index: number; anchor: PlanAnchor }[] = [];
  for (const key of context.cites) {
    const entry = getShapeEntry(db, context.shapeId, key);
    if (entry === undefined || (entry.kind !== 'fact' && entry.kind !== 'experiment')) continue;
    entry.anchors.forEach((anchor, index) => {
      if (!done.has(JSON.stringify([key, entry.version, index])))
        todo.push({ key, version: entry.version, index, anchor });
    });
  }
  if (todo.length === 0) return 0;

  // Each path is read once, whatever number of anchors name it.
  const reads = new Map<string, Promise<FileRead>>();
  const readAt = (path: string): Promise<FileRead> => {
    const held = reads.get(path);
    if (held) return held;
    const read = deps.git
      .fileAt(input.repo, input.rev, path, ANCHOR_FILE_MAX_BYTES)
      .catch((error: unknown): FileRead => ({ kind: 'error', note: firstLine(error) }));
    reads.set(path, read);
    return read;
  };

  const rows: NewAnchorCheck[] = [];
  for (const { key, version, index, anchor } of todo) {
    const row = {
      workstreamId: input.workstreamId,
      entryKey: key,
      entryVersion: version,
      anchorIndex: index,
      checkedCommit: input.rev,
    };
    if (anchor.kind === 'url') {
      rows.push({ ...row, result: AnchorResult.Url, line: null, note: null });
      continue;
    }
    const file = await readAt(anchor.path);
    switch (file.kind) {
      case 'file': {
        const found = locateAnchor(file.text, anchor);
        rows.push({ ...row, result: found.result, line: found.line, note: null });
        break;
      }
      case 'missing':
      case 'not_regular':
        rows.push({ ...row, result: AnchorResult.Changed, line: null, note: null });
        break;
      case 'too_large':
        rows.push({
          ...row,
          result: AnchorResult.Unchecked,
          line: null,
          note: 'the file is over 4 MiB',
        });
        break;
      case 'error':
        rows.push({ ...row, result: AnchorResult.Unchecked, line: null, note: file.note });
        break;
    }
  }
  deps.state.write((ctx) => {
    insertAnchorChecks(ctx, input.taskId, rows);
  });
  return rows.length;
}
