import { ConversationItemId, idUuid, mintId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { clientUuid, pushedAgainAfter } from './delivery-rules';

// Sessions spec §6.2 rules 2 and 4: the uuid a push goes under, and what an interrupt pushes again.

const FRESH = 'c0ffee00-0000-4000-8000-0000000000ff';
const fresh = () => FRESH;
const migrated = ConversationItemId.parse(`tmg_${idUuid(mintId('ConversationItem'))}`);
const minted = mintId('ConversationItem');

describe('clientUuid', () => {
  it.each([
    {
      name: 'a new message never pushed goes under its own uuid',
      id: minted,
      pushedAt: null,
      pushUuids: [],
      own: true,
    },
    {
      name: 'a migrated message never pushed goes under its own uuid',
      id: migrated,
      pushedAt: null,
      pushUuids: [],
      own: true,
    },
    {
      name: 'a message pushed once goes under a fresh uuid',
      id: minted,
      pushedAt: '2026-11-13T00:00:00.000Z',
      pushUuids: ['u-1'],
      own: false,
    },
    {
      name: 'a message handed back goes under a fresh uuid',
      id: minted,
      pushedAt: null,
      pushUuids: ['u-1'],
      own: false,
    },
  ])('$name', ({ id, pushedAt, pushUuids, own }) => {
    expect(clientUuid({ id, pushedAt, pushUuids }, fresh)).toBe(own ? idUuid(id) : FRESH);
  });
});

describe('pushedAgainAfter', () => {
  const a = { id: mintId('ConversationItem') };
  const b = { id: mintId('ConversationItem') };
  it.each([
    { name: 'with no receipt, every undelivered message', queued: null, again: [a, b] },
    { name: 'with a receipt naming one, the others', queued: new Set([a.id]), again: [b] },
  ])('$name', ({ queued, again }) => {
    expect(pushedAgainAfter([a, b], queued)).toEqual(again);
  });
});
