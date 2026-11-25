import { randomBytes } from 'node:crypto';
import type { DeviceId, EventTicketDto, TicketScope } from '@10db/contracts';
import type { Listener } from '../api';
import type { Clock } from '../clock';

export interface TicketOwner {
  readonly scope: TicketScope;
  readonly deviceId: DeviceId | null;
  readonly listener: Listener;
}

export interface Tickets {
  /** 24 random bytes, base64url, good for 30 seconds. */
  issue(owner: TicketOwner): EventTicketDto;
  /** Spends the ticket; null when unknown, spent, expired or issued on the other listener. */
  spend(ticket: string, listener: Listener): TicketOwner | null;
}

const LIFETIME_MS = 30_000;

interface Entry {
  readonly owner: TicketOwner;
  readonly expiresAt: number;
}

export function createTickets(deps: { readonly clock: Clock }): Tickets {
  const entries = new Map<string, Entry>();

  return {
    issue(owner) {
      const now = deps.clock.now().getTime();
      for (const [key, entry] of entries) {
        if (entry.expiresAt <= now) entries.delete(key);
      }
      const ticket = randomBytes(24).toString('base64url');
      const expiresAt = now + LIFETIME_MS;
      entries.set(ticket, { owner, expiresAt });
      return { ticket, expiresAt: new Date(expiresAt).toISOString() };
    },
    spend(ticket, listener) {
      const entry = entries.get(ticket);
      // Deleted on any lookup, so a refused presentation still burns the ticket.
      entries.delete(ticket);
      if (!entry) return null;
      if (entry.expiresAt <= deps.clock.now().getTime()) return null;
      if (entry.owner.listener !== listener) return null;
      return entry.owner;
    },
  };
}
