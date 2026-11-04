import type { ShapeId } from '@10db/contracts';
import { useSyncExternalStore } from 'react';

/**
 * What a send or a file drop on the new-conversation screen has to tell the builder after the
 * screen has left for the conversation they made. The two share one create and finish on their own,
 * so whichever finishes first opens the conversation and the screen, its route and its input are
 * gone under the other; this is how the other's failure, and the text of a failed send, reach the
 * input that replaced it. It lives outside React because the new-conversation route unmounts.
 */
export interface LateOutcome {
  /** Why files were refused. */
  readonly refused: readonly string[];
  /** Why a send failed. */
  readonly failure: string | null;
  /** The text of the send that failed, to put back in the input. */
  readonly draft: string | null;
}

const waiting = new Map<ShapeId, LateOutcome>();
const listeners = new Set<() => void>();

const changed = (): void => {
  for (const listener of listeners) listener();
};

/** Adds `more` to what waits for `shapeId`; a later failure or draft replaces an earlier one. */
export function leaveLate(shapeId: ShapeId, more: Partial<LateOutcome>): void {
  const base = waiting.get(shapeId);
  waiting.set(shapeId, {
    refused: [...(base?.refused ?? []), ...(more.refused ?? [])],
    failure: more.failure ?? base?.failure ?? null,
    draft: more.draft ?? base?.draft ?? null,
  });
  changed();
}

/** The input has taken what waited for `shapeId`. */
export function takeLate(shapeId: ShapeId): void {
  if (waiting.delete(shapeId)) changed();
}

/** What waits for this conversation's input, or null. */
export function useLate(shapeId: ShapeId | null): LateOutcome | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => (shapeId === null ? null : (waiting.get(shapeId) ?? null)),
  );
}
