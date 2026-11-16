import { mintId } from '@10db/contracts';
import { createTestStore } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createEventBus, createStateStore } from '../events';
import { createPendingOpens } from './pending-open';

// A pending open is memory, cancelled by the builder or by the update's drain; the routes' tests cover the rest.

const projectId = mintId('Project');
const other = mintId('Project');
let close: () => void = () => undefined;
afterEach(() => {
  close();
});

function opens() {
  const { store, close: closeStore } = createTestStore();
  close = closeStore;
  return createPendingOpens({ state: createStateStore(store, createEventBus()) });
}
const open = { name: 'Polish pages', waitsFor: 'the chat ‘A chat’', chatId: null };

describe('a pending open', () => {
  it('aborts its signal on cancel, and every project’s on cancelAll', () => {
    const pending = opens();
    const first = pending.begin(projectId, open);
    const second = pending.begin(other, open);

    expect(pending.cancel(projectId)).toBe(true);
    expect(first.aborted).toBe(true);
    expect(second.aborted).toBe(false);
    pending.cancelAll();
    expect(second.aborted).toBe(true);
    expect(pending.cancel(mintId('Project'))).toBe(false);
  });

  it('is not ended by the job of a wait that was cancelled before it', () => {
    const pending = opens();
    const old = pending.begin(projectId, open);
    pending.cancel(projectId);
    const fresh = pending.begin(projectId, { ...open, name: 'Second' });

    // The first wait's job is still queued behind other work, and ends when it gets its turn.
    pending.end(projectId, old);

    expect(pending.view(projectId)?.name).toBe('Second');
    pending.end(projectId, fresh);
    expect(pending.view(projectId)).toBeNull();
  });
});
