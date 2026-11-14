import { ConversationItemId, idUuid, mintId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { clientUuid, pushedAgainAfter, readBackAsk } from './delivery-rules';

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

describe('readBackAsk', () => {
  const at = (n: number) => `2026-11-13T00:0${String(n)}:00.000Z`;
  it.each([
    { name: 'nothing pushed asks nothing', inDoubt: [], ask: null },
    {
      name: 'a message never pushed under a uuid is not asked about',
      inDoubt: [{ pushUuids: [], createdAt: at(1) }],
      ask: null,
    },
    {
      name: 'every uuid each pushed message went under, since the oldest was written',
      inDoubt: [
        { pushUuids: ['u-1', 'u-2'], createdAt: at(1) },
        { pushUuids: [], createdAt: at(2) },
        { pushUuids: ['u-3'], createdAt: at(3) },
      ],
      ask: { wanted: ['u-1', 'u-2', 'u-3'], since: at(1) },
    },
  ])('$name', ({ inDoubt, ask }) => {
    expect(readBackAsk(inDoubt)).toEqual(ask);
  });
});
