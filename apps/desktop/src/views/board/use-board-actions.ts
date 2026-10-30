import type { InboxItemDto, ProjectId, TaskDto, TaskId } from '@10db/contracts';
import { useState } from 'react';
import { useInbox, useRunNext, useStartTask } from '../../daemon/queries';
import type { DropAction } from './drop-rules';
import { runNextNote } from './queue-place';
import {
  refusalCards,
  START_ANSWER_MS,
  startNote,
  type StartAttempt,
  type StartNote,
} from './start-note';
import { useMoveTask } from './use-move-task';

/** Carries out a drop or a menu move: a placement, a start, or a refusal shown to the builder. */
export function useBoardActions(projectId: ProjectId) {
  const move = useMoveTask(projectId);
  const start = useStartTask();
  const runNext = useRunNext();
  const inbox = useInbox();
  const [notice, setNotice] = useState<string | null>(null);
  // Each task's latest Start, so its card can say it is starting or why it was not.
  const [attempts, setAttempts] = useState<ReadonlyMap<TaskId, StartAttempt>>(new Map());
  const cards = refusalCards(inbox.data ?? []);
  const note = (task: TaskDto, startable: boolean): StartNote | null =>
    startNote({ attempt: attempts.get(task.id), task, startable, card: cards.get(task.id) });

  function remember(taskId: TaskId, attempt: StartAttempt | null): void {
    setAttempts((current) => {
      const next = new Map(current);
      if (attempt) next.set(taskId, attempt);
      else next.delete(taskId);
      return next;
    });
  }

  function begin(task: TaskDto, card: InboxItemDto | undefined): void {
    const asked = {
      workstreamId: task.workstreamId,
      // A refusal the daemon repeats folds into the card the builder already has; its change is the sign.
      seen: card?.updatedAt ?? null,
    };
    remember(task.id, { phase: 'requesting', ...asked });
    start.mutateAsync(task.id).then(
      () => {
        const waiting: StartAttempt = { phase: 'waiting', ...asked };
        remember(task.id, waiting);
        // Some cuts end with neither a run nor a card; past this the card stops promising a start.
        setTimeout(() => {
          setAttempts((current) => {
            if (current.get(task.id) !== waiting) return current;
            return new Map(current).set(task.id, { ...waiting, phase: 'quiet' });
          });
        }, START_ANSWER_MS);
      },
      (error: unknown) => {
        remember(task.id, {
          phase: 'failed',
          reason: error instanceof Error ? error.message : String(error),
        });
      },
    );
  }

  function apply(action: DropAction, task?: TaskDto): void {
    switch (action.kind) {
      case 'none':
        return;
      case 'refuse':
        setNotice(action.reason);
        return;
      case 'move':
        setNotice(null);
        remember(action.taskId, null);
        move.mutate(action, {
          onSuccess: () => {
            setNotice(action.note);
          },
        });
        return;
      case 'start': {
        if (!task) return;
        // One request at a time per task: a second Start while the first is out would only repeat it.
        if (note(task, true)?.kind === 'starting') return;
        setNotice(null);
        move.reset();
        begin(task, cards.get(task.id));
        return;
      }
    }
  }
  /** Puts a queued task first in line, and says when it will run if it waits on others. */
  function runNextFor(task: TaskDto): void {
    setNotice(null);
    runNext.reset();
    runNext.mutate(task.id, {
      onSuccess: ({ waitingOn }) => {
        setNotice(runNextNote(task.title, waitingOn));
      },
    });
  }
  return {
    apply,
    runNext: runNextFor,
    notice,
    /** What a startable task's card says about its Start; null when there is nothing to say. */
    note,
    failure: move.error
      ? { title: "Couldn't move the task", error: move.error }
      : runNext.error
        ? { title: "Couldn't put the task first", error: runNext.error }
        : null,
    dismiss: () => {
      setNotice(null);
    },
  };
}
