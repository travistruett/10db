import type { ProjectId } from '@10db/contracts';
import { useState } from 'react';
import { useStartTask } from '../../daemon/queries';
import type { DropAction } from './drop-rules';
import { useMoveTask } from './use-move-task';

/** Carries out a drop or a menu move: a placement, a start, or a refusal shown to the builder. */
export function useBoardActions(projectId: ProjectId) {
  const move = useMoveTask(projectId);
  const start = useStartTask();
  const [notice, setNotice] = useState<string | null>(null);
  function apply(action: DropAction): void {
    switch (action.kind) {
      case 'none':
        return;
      case 'refuse':
        setNotice(action.reason);
        return;
      case 'move':
        setNotice(null);
        start.reset();
        move.mutate(action, {
          onSuccess: () => {
            setNotice(action.note);
          },
        });
        return;
      case 'start':
        setNotice(null);
        move.reset();
        start.mutate(action.taskId);
        return;
    }
  }
  // Each action clears the other's error, so at most one is set: the latest action's.
  const failure = move.error
    ? { title: "Couldn't move the task", error: move.error }
    : start.error
      ? { title: "Couldn't start the task", error: start.error }
      : null;
  return {
    apply,
    notice,
    failure,
    dismiss: () => {
      setNotice(null);
    },
  };
}
