import type { ProjectId, TaskId } from '@10db/contracts';
import { useState } from 'react';
import { useHoldTask, useRemoveTask, useStartTask } from '../../daemon/queries';
import type { DropAction } from './drop-rules';
import { useMoveTask } from './use-move-task';

/** Carries out a drop or a menu move: a placement, a start, or a refusal shown to the builder. */
export function useBoardActions(projectId: ProjectId) {
  const move = useMoveTask(projectId);
  const start = useStartTask();
  const hold = useHoldTask();
  const remove = useRemoveTask();
  const [notice, setNotice] = useState<string | null>(null);
  const all = [move, start, hold, remove];
  /** Each action clears the others' errors, so at most one is set: the latest action's. */
  const clearErrorsExcept = (keep: unknown) => {
    for (const mutation of all) if (mutation !== keep) mutation.reset();
  };
  function apply(action: DropAction): void {
    switch (action.kind) {
      case 'none':
        return;
      case 'refuse':
        setNotice(action.reason);
        return;
      case 'move':
        setNotice(null);
        clearErrorsExcept(move);
        move.mutate(action, {
          onSuccess: () => {
            setNotice(action.note);
          },
        });
        return;
      case 'start':
        setNotice(null);
        clearErrorsExcept(start);
        start.mutate(action.taskId);
        return;
    }
  }
  const failure = move.error
    ? { title: "Couldn't move the task", error: move.error }
    : start.error
      ? { title: "Couldn't start the task", error: start.error }
      : hold.error
        ? { title: "Couldn't hold the task", error: hold.error }
        : remove.error
          ? { title: "Couldn't remove the task", error: remove.error }
          : null;
  return {
    apply,
    /** Sets a started task that has not run aside. */
    hold: (taskId: TaskId) => {
      setNotice(null);
      clearErrorsExcept(hold);
      hold.mutate(taskId);
    },
    /** Removes a held task, with its worktree and branch. */
    remove: (taskId: TaskId) => {
      setNotice(null);
      clearErrorsExcept(remove);
      remove.mutate(taskId);
    },
    notice,
    failure,
    dismiss: () => {
      setNotice(null);
    },
  };
}
