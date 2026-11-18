import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { InboxState, type BatchDto } from '@10db/contracts';
import { getBatch, getInboxItem, listInbox } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { wrongBranchCard } from './cards';
import { resolveBranchReadyCards } from './branch-ready';
import { switchToBatchBranch } from './checkout-switch';
import { raise } from './context';

let h: DeliveryHarness;
let batch: BatchDto;
beforeEach(async () => {
  h = createDeliveryHarness();
  const task = h.addTask('Alpha');
  const started = h.only(
    h.starter.startBatch(h.project.id, { title: 'Greetings', taskIds: [task.id] }),
  );
  await h.jobs.idle();
  batch = getBatch(h.store.db, started.id);
});
afterEach(() => {
  h.close();
});

/** Takes the checkout off the batch branch, as the builder does, and raises the card the scheduler raises. */
function checkoutOff(): void {
  h.git$('switch', '-q', 'main');
  raise(h.inbox, h.project.id, wrongBranchCard(batch, 'main', h.repo, 'waits'));
}

const open = () => listInbox(h.store.db, { states: [InboxState.Open] });

// Real git: the closer reads the checkout's branch itself, so it follows what git says.
describe('branch_ready', () => {
  it('closes the wrong-branch card once the checkout is back on the batch branch, and not before', async () => {
    checkoutOff();
    const deps = { db: h.store.db, git: h.git, inbox: h.inbox };
    expect(open()).toHaveLength(1);

    expect(await resolveBranchReadyCards(deps, batch)).toBe(false);
    expect(open()).toHaveLength(1);

    h.git$('switch', '-q', batch.branch ?? '');
    expect(await resolveBranchReadyCards(deps, batch)).toBe(true);
    expect(open()).toHaveLength(0);
  });

  it('Switch Back puts the checkout on the batch branch and closes the card', async () => {
    checkoutOff();
    await switchToBatchBranch(h.ctx, batch.id);
    expect(h.git$('branch', '--show-current')).toBe(batch.branch);
    expect(open()).toHaveLength(0);
  });

  it('Switch Back leaves a checkout with a change in the way, and a new card says why', async () => {
    checkoutOff();
    h.git$('switch', '-q', batch.branch ?? '');
    h.commit('src/shared.txt', 'batch\n');
    h.git$('switch', '-q', 'main');
    h.commit('src/shared.txt', 'main\n');
    writeFileSync(join(h.repo, 'src/shared.txt'), 'edited\n');
    await switchToBatchBranch(h.ctx, batch.id);
    expect(h.git$('branch', '--show-current')).toBe('main');
    const [card] = open();
    expect(card?.body).toContain('Switch Back did not switch it');
    expect(card?.body).toContain('src/shared.txt');
    expect(getInboxItem(h.store.db, card?.id ?? ('' as never)).state).toBe(InboxState.Open);
  });
});
