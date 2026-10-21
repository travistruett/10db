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
        move.mutate(action, {
          onSuccess: () => {
            setNotice(action.note);
          },
        });
        return;
      case 'start':
        setNotice(null);
        start.mutate(action.taskId);
        return;
    }
  }
  return {
    apply,
    notice,
    error: move.error ?? start.error,
    dismiss: () => {
      setNotice(null);
    },
  };
}
