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
  /** What goes in the input: what it held when it left, the text of a send that failed, or both. */
  readonly draft: string | null;
}

/**
 * One text holding both: the first when it is the second's whole text, otherwise the second ahead.
 * Only a whole match counts. A failed "ok" inside "look at this" is a message of its own.
 */
export function keepBoth(typed: string, failed: string): string {
  if (typed.trim() === '' || typed.trim() === failed.trim()) return failed;
  return `${failed}\n\n${typed}`;
}

/**
 * What the input holds once the send of `sent` succeeds: nothing when it is just that text, and
 * otherwise the text with the sent part taken off the end, where `keepBoth` puts what was typed
 * during the send. An input edited into something else stays as it stands.
 */
export function withoutSent(typed: string, sent: string): string {
  const text = typed.trim();
  if (text === sent) return '';
  const tail = `\n\n${sent}`;
  return text.endsWith(tail) ? text.slice(0, -tail.length) : typed;
}

const waiting = new Map<ShapeId, LateOutcome>();
const listeners = new Set<() => void>();

const changed = (): void => {
  for (const listener of listeners) listener();
};

/** Adds `more` to what waits for `shapeId`: a later failure replaces an earlier one, a draft joins it. */
export function leaveLate(shapeId: ShapeId, more: Partial<LateOutcome>): void {
  const base = waiting.get(shapeId);
  const { draft = null } = more;
  waiting.set(shapeId, {
    refused: [...(base?.refused ?? []), ...(more.refused ?? [])],
    failure: more.failure ?? base?.failure ?? null,
    draft: draft === null ? (base?.draft ?? null) : keepBoth(base?.draft ?? '', draft),
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
