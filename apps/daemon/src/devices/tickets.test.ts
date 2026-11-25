import { mintId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { Listener } from '../api';
import { ManualClock } from '../clock';
import { createTickets } from './tickets';

describe('stream tickets', () => {
  const owner = { scope: 'full', deviceId: mintId('Device'), listener: Listener.Share } as const;

  it('spends once, on its own listener, within 30 seconds', () => {
    const clock = new ManualClock();
    const tickets = createTickets({ clock });

    const first = tickets.issue(owner).ticket;
    expect(tickets.spend(first, Listener.Share)).toEqual(owner);
    expect(tickets.spend(first, Listener.Share)).toBeNull();

    const late = tickets.issue(owner).ticket;
    clock.advance(30_000);
    expect(tickets.spend(late, Listener.Share)).toBeNull();

    const crossed = tickets.issue(owner).ticket;
    expect(tickets.spend(crossed, Listener.Main)).toBeNull();
    expect(tickets.spend(crossed, Listener.Share)).toBeNull();
  });
});
