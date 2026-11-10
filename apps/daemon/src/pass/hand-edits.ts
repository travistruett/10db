import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskId, WorkstreamId } from '@10db/contracts';
import {
  getTask,
  getWorkstreamRow,
  insertSystemNotice,
  listPassTurns,
  openPassTurn,
} from '@10db/db';
import {
  keepTurnWork,
  keptWorkFacts,
  pageClaims,
  pageMatcher,
  passKeptRef,
  passTaskPlace,
  readKeptRef,
  type FileChange,
  type KeptWork,
  type PassWorkDeps,
} from './kept-work';

// Workbench spec §6.4: the builder's hand edits. When the builder writes to a page, its files that
// differ from what its last turn left are kept at once as one more kept commit, named on the thread
// and at the head of the message the agent gets, so it keeps them.

/** What a fold of the builder's edits found and kept. */
export interface HandEditFold {
  readonly kept: KeptWork;
  /** Files the builder changed since the page's last turn. */
  readonly byHand: readonly FileChange[];
  /**
   * Files changed outside the page's turns while another page's agent was working, so maybe through
   * its shell, which the guard's hook does not see: not called the builder's. Null with none.
   */
  readonly whileWorking: {
    readonly lanes: readonly string[];
    readonly files: readonly FileChange[];
  } | null;
  /** What the agent's next message starts with; null when nothing was folded. */
  readonly agentNote: string | null;
}

/** A mark of uncertainty: a write this close to another turn is taken to be that turn's. */
const WINDOW_SLACK_MS = 1_000;

const lines = (files: readonly FileChange[], before: ReadonlySet<string>): string =>
  files
    .map(
      (f) =>
        `- ${f.path} +${String(f.added)} −${String(f.removed)}${before.has(f.path) ? ' (from before the pass)' : ''}`,
    )
    .join('\n');

const count = (n: number): string => `${String(n)} file${n === 1 ? '' : 's'}`;

/** The thread's notice for a fold. */
function noticeOf(fold: HandEditFold, before: ReadonlySet<string>): string {
  const parts: string[] = [];
  if (fold.byHand.length > 0)
    parts.push(
      `You edited ${count(fold.byHand.length)} by hand; ${fold.byHand.length === 1 ? 'it is' : 'they are'} kept with this page:\n${lines(fold.byHand, before)}`,
    );
  if (fold.whileWorking)
    parts.push(
      `${count(fold.whileWorking.files.length)} changed outside this page's turns, while ${fold.whileWorking.lanes.join(' and ')} was working:\n${lines(fold.whileWorking.files, before)}`,
    );
  return parts.join('\n\n');
}

/** What the agent is told of a fold, ahead of the builder's message. */
function agentNoteOf(fold: Omit<HandEditFold, 'agentNote'>, before: ReadonlySet<string>): string {
  const parts: string[] = [];
  if (fold.byHand.length > 0)
    parts.push(
      `The builder edited these files by hand since your last turn. Keep their changes:\n${lines(fold.byHand, before)}`,
    );
  if (fold.whileWorking)
    parts.push(
      `These files changed outside your turns, while ${fold.whileWorking.lanes.join(' and ')} was working. Keep their changes too:\n${lines(fold.whileWorking.files, before)}`,
    );
  return parts.join('\n\n');
}

/**
 * Folds the builder's edits into the task's kept work (spec §6.4): the page files that differ from
 * the task's last kept commit (the pass branch's tip before its first) are kept as one more kept
 * commit, and the thread names them. A file whose last write fell in another page's turn while it
 * worked is named apart, erring toward that page: the mtime is all there is. While the page's own
 * turn is open nothing is folded, since a hand edit then can't be told from the agent's own and is
 * kept with the turn.
 */
export async function foldHandEdits(
  deps: PassWorkDeps,
  input: { readonly workstreamId: WorkstreamId },
): Promise<HandEditFold> {
  const db = deps.state.db;
  const { taskId } = getWorkstreamRow(db, input.workstreamId);
  const nothing = async (): Promise<HandEditFold> => ({
    kept: { ...(await keptWorkFacts(deps, taskId)), made: false, turnFiles: [] },
    byHand: [],
    whileWorking: null,
    agentNote: null,
  });
  if (openPassTurn(db, taskId)) return nothing();
  const place = passTaskPlace(db, taskId);
  const { git } = deps;
  const mine = pageMatcher(place.project, pageClaims(db, place.project, place.task));
  const last = await readKeptRef(git, place.repo, passKeptRef(place.pass.id, taskId));
  const tip = await git.commitAt(place.repo, place.branch);
  // What differs from the tip now, and what the last kept commit changed, which the builder may
  // have put back as the tip has it.
  const candidates = [
    ...new Set([
      ...(await git.changedPaths(place.repo)),
      ...(last === null ? [] : await git.filesChangedBetween(place.repo, tip, last)),
    ]),
  ].filter(mine);
  const changed = await git.pageChanges(place.repo, last ?? tip, candidates);
  if (changed.length === 0) return nothing();

  const windows = listPassTurns(db, place.pass.id)
    .filter((t) => t.taskId !== taskId)
    .map((t) => ({
      taskId: t.taskId,
      from: new Date(t.startedAt).getTime() - WINDOW_SLACK_MS,
      to: new Date(t.endedAt ?? deps.state.now()).getTime() + WINDOW_SLACK_MS,
    }));
  const byHand: FileChange[] = [];
  const whileWorking: FileChange[] = [];
  const lanes = new Set<TaskId>();
  for (const file of changed) {
    const mtime = lstatSync(join(place.repo, file.path), { throwIfNoEntry: false })?.mtimeMs;
    const during =
      mtime === undefined ? [] : windows.filter((w) => w.from <= mtime && mtime <= w.to);
    if (during.length === 0) byHand.push(file);
    else {
      whileWorking.push(file);
      for (const w of during) lanes.add(w.taskId);
    }
  }
  const kept = await keepTurnWork(deps, { workstreamId: input.workstreamId, turnId: null });
  const before = new Set(kept.fromBeforePass);
  const found = {
    kept,
    byHand,
    whileWorking:
      whileWorking.length === 0
        ? null
        : { lanes: [...lanes].map((id) => getTask(db, id).title).sort(), files: whileWorking },
  };
  const fold: HandEditFold = { ...found, agentNote: agentNoteOf(found, before) };
  deps.state.write((ctx) => insertSystemNotice(ctx, taskId, noticeOf(fold, before)));
  return fold;
}
