import type { GoalAdoptIssue, ProjectId } from '@10db/contracts';
import { useState } from 'react';
import { useAdoptGoal } from '../../daemon/goal-queries';
import { canChoosePlan, choosePlan } from '../../desktop/choose-plan';

/** A plan the daemon refused, and every reason why. */
export interface Refusal {
  readonly path: string;
  readonly errors: readonly GoalAdoptIssue[];
}

export interface AdoptPlan {
  readonly refusal: Refusal | null;
  /** True while the browser's typed-path form is open (there is no native panel there). */
  readonly typing: boolean;
  readonly adopting: boolean;
  /** Why adopting failed for a reason other than the brief: an unreadable file, a daemon fault. */
  readonly problem: string | null;
  /** Opens the native panel, or the typed-path form where there is none. */
  readonly pick: () => void;
  /** Adopts the plan at a path the builder typed. */
  readonly adoptPath: (path: string) => void;
  readonly dismissRefusal: () => void;
  readonly dismissTyping: () => void;
}

/**
 * Adopt a Plan…: pick a `.md` file, post its path, and keep a refusal up until the builder picks
 * again or cancels. Success needs no state here: the goal list refetches and shows the new goal.
 */
export function useAdoptPlan(projectId: ProjectId | null): AdoptPlan {
  const adopt = useAdoptGoal(projectId);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [typing, setTyping] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);

  const adoptPath = (path: string) => {
    setPickError(null);
    adopt.mutate(path, {
      onSuccess: (result) => {
        setTyping(false);
        setRefusal(result.kind === 'refused' ? { path, errors: result.errors } : null);
      },
    });
  };

  const pick = () => {
    setPickError(null);
    if (!canChoosePlan()) {
      setRefusal(null);
      setTyping(true);
      return;
    }
    choosePlan().then(
      (path) => {
        if (path !== null) adoptPath(path);
      },
      (error: unknown) => {
        setPickError(error instanceof Error ? error.message : 'The file panel failed.');
      },
    );
  };

  return {
    refusal,
    typing,
    adopting: adopt.isPending,
    problem: pickError ?? (adopt.isError ? adopt.error.message : null),
    pick,
    adoptPath,
    dismissRefusal: () => {
      setRefusal(null);
    },
    dismissTyping: () => {
      setTyping(false);
    },
  };
}
