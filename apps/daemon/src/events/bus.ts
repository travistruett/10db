import type { DaemonEvent } from '@10db/contracts';

export interface EventBus {
  publish(events: readonly DaemonEvent[]): void;
  subscribe(listener: (event: DaemonEvent) => void): () => void;
}

/** Delivers each event to every listener; a throwing listener is reported and does not stop the rest. */
export function createEventBus(
  onListenerError: (error: unknown) => void = () => undefined,
): EventBus {
  const listeners = new Set<(event: DaemonEvent) => void>();
  return {
    publish(events) {
      for (const event of events) {
        for (const listener of listeners) {
          try {
            listener(event);
          } catch (error) {
            onListenerError(error);
          }
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
