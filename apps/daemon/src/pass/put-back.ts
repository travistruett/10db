import type { TaskId } from '@10db/contracts';
import {
  findPass,
  getTaskKeptWork,
  insertSystemNotice,
  lastTakeOut,
  setTaskKeptWork,
} from '@10db/db';
import { passDirtRef } from '../delivery';
import { keepPutBackWork, keptRef, readKeptRef, type PassWorkDeps } from './kept-work';

// Workbench spec §5.4: a taken-out task's kept work goes back into the folder when a later pass takes
// it, file by file, so nothing the builder did to a file since is written over.

const count = (n: number): string => `${String(n)} file${n === 1 ? '' : 's'}`;

/**
 * Puts the task's kept work back into the folder at `repo`, file by file. A file still exactly as the
 * task's last take-out left it (the former pass's branch version where that pass had landed on it,
 * else the file as it was before that pass) takes the kept version; any other is merged three ways
 * from the commit the work was kept on; one that does not merge is left as it is and named on the
 * thread. A file the take-out itself left, because it kept changing, is not touched. What went back
 * is kept at once as the task's work in its pass. The task records as saved only what did not go
 * back: none, or a commit on the kept one holding only those files, so a later take-out or a rerun
 * never writes over it; its ref stays until the work lands. A rerun after a restart takes a file
 * already holding the kept version as put back, and writes nothing on the thread when nothing changed.
 */
export async function putBackKeptWork(
  deps: PassWorkDeps,
  input: { readonly repo: string; readonly taskId: TaskId },
): Promise<{ readonly applied: readonly string[]; readonly left: readonly string[] }> {
  const db = deps.state.db;
  const { git } = deps;
  const { repo, taskId } = input;
  const kept = getTaskKeptWork(db, taskId);
  if (kept === null) return { applied: [], left: [] };
  const last = lastTakeOut(db, taskId);
  const former = last === undefined ? undefined : findPass(db, last.passId);
  const leftThen = new Set(last?.left ?? []);
  const touched = new Set(
    former === undefined
      ? []
      : await git.filesChangedBetween(repo, former.startSha, kept.keptBaseSha),
  );
  const before =
    former === undefined
      ? kept.keptBaseSha
      : ((await readKeptRef(git, repo, passDirtRef(former.id))) ?? former.startSha);
  const files = (await git.filesChangedBetween(repo, kept.keptBaseSha, kept.keptSha)).filter(
    (path) => !leftThen.has(path),
  );
  const onDisk = new Map((await git.hashOnDisk(repo, files)).map((f) => [f.path, f.blob]));
  const applied: string[] = [];
  const left: string[] = [];
  for (const path of files) {
    const now = onDisk.get(path) ?? null;
    // Already the kept version: put back by a run a restart cut short.
    if (now === (await git.blobAt(repo, kept.keptSha, path))) {
      applied.push(path);
      continue;
    }
    const asLeft = await git.blobAt(repo, touched.has(path) ? kept.keptBaseSha : before, path);
    if (now === asLeft) {
      const done = await git.restoreFiles(
        repo,
        [{ path, from: kept.keptSha }],
        [{ path, blob: now }],
      );
      (done.left.length === 0 ? applied : left).push(path);
      continue;
    }
    const merged = await git.mergeFileBack({
      repo,
      path,
      base: kept.keptBaseSha,
      theirs: kept.keptSha,
    });
    (merged === 'merged' ? applied : left).push(path);
  }
  await git.refreshIndex(repo, applied);
  await keepPutBackWork(deps, taskId, applied);
  const still =
    left.length === 0
      ? null
      : {
          keptSha:
            left.length === files.length
              ? kept.keptSha
              : await git.narrowKeptRef(
                  repo,
                  keptRef(taskId),
                  { sha: kept.keptSha, base: kept.keptBaseSha },
                  left,
                ),
          keptBaseSha: kept.keptBaseSha,
        };
  if (applied.length === 0 && still?.keptSha === kept.keptSha) return { applied, left };
  deps.state.write((ctx) => {
    setTaskKeptWork(ctx, taskId, still);
    insertSystemNotice(
      ctx,
      taskId,
      `Put back its saved Workbench work: ${count(applied.length)}.` +
        (left.length === 0
          ? ''
          : `\nLeft as they are, because the saved work does not merge with them:\n${left.map((p) => `- ${p}`).join('\n')}`),
    );
  });
  return { applied, left };
}
