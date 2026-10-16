/** A single-consumer async queue: push values, then end; iterate with for-await. */
export interface Channel<T> extends AsyncIterable<T> {
  push(value: T): void;
  end(): void;
}

export function createChannel<T>(): Channel<T> {
  const buffer: T[] = [];
  let ended = false;
  let wake: (() => void) | null = null;
  const notify = (): void => {
    wake?.();
    wake = null;
  };
  return {
    push(value) {
      if (ended) return;
      buffer.push(value);
      notify();
    },
    end() {
      ended = true;
      notify();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const next = buffer.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}
