import { describe, expect, it } from 'vitest';
import { askWithin } from './ask-within';
import type { AreaNamer } from './propose-areas';

/** An asker that answers only when its signal is aborted, by rejecting, and says whether it was. */
function hanging(): { asker: AreaNamer; aborted: () => boolean } {
  let seen: AbortSignal | undefined;
  return {
    asker: (_prompt, signal) => {
      seen = signal;
      return new Promise<string>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new Error('stopped'));
        });
      });
    },
    aborted: () => seen?.aborted === true,
  };
}

describe('askWithin', () => {
  it('gives the answer, and ends the question after it', async () => {
    let seen: AbortSignal | undefined;
    const asker: AreaNamer = (prompt, signal) => {
      seen = signal;
      return Promise.resolve(`answer to ${prompt}`);
    };
    await expect(askWithin(asker, 'q', 60_000)).resolves.toBe('answer to q');
    expect(seen?.aborted).toBe(true);
  });

  it('is null when the asker fails', async () => {
    await expect(
      askWithin(() => Promise.reject(new Error('no model')), 'q', 60_000),
    ).resolves.toBeNull();
  });

  it('is null at the bound, and stops the question', async () => {
    const { asker, aborted } = hanging();
    await expect(askWithin(asker, 'q', 20)).resolves.toBeNull();
    expect(aborted()).toBe(true);
  });

  it('is null when the caller gives up, and stops the question', async () => {
    const { asker, aborted } = hanging();
    const caller = new AbortController();
    const asked = askWithin(asker, 'q', 60_000, caller.signal);
    caller.abort();
    await expect(asked).resolves.toBeNull();
    expect(aborted()).toBe(true);
  });

  it('asks nothing for a caller that has given up already', async () => {
    let asked = false;
    const caller = new AbortController();
    caller.abort();
    const asker: AreaNamer = () => {
      asked = true;
      return Promise.resolve('x');
    };
    await expect(askWithin(asker, 'q', 60_000, caller.signal)).resolves.toBeNull();
    expect(asked).toBe(false);
  });

  it('does not wait on an asker that ignores its signal', async () => {
    await expect(
      askWithin(() => new Promise<string>(() => undefined), 'q', 20),
    ).resolves.toBeNull();
  });
});
