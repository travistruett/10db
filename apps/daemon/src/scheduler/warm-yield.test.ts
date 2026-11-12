import { mintId, type AccountId, type PassId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { laneToYield, type RoomAsk, type WarmLane } from './warm-yield';

// Workbench spec §5.2, §6.3: a warm session yields its lane to work that has no room.

const account: AccountId = mintId('Account');
const otherAccount: AccountId = mintId('Account');
const pass: PassId = mintId('Pass');
const otherPass: PassId = mintId('Pass');

const lane = (
  name: string,
  over: Partial<WarmLane>,
  idleSince: string,
): WarmLane & { name: string } => ({
  name,
  id: mintId('Workstream'),
  passId: pass,
  accountId: account,
  idleSince,
  ...over,
});
const older = lane('older, same pass', {}, '2026-11-09T10:00:00.000Z');
const newer = lane('newer, same pass', {}, '2026-11-09T11:00:00.000Z');
const elsewhere = lane('oldest, another pass', { passId: otherPass }, '2026-11-09T09:00:00.000Z');
const otherAcc = lane(
  'oldest of all, another account',
  { passId: otherPass, accountId: otherAccount },
  '2026-11-09T08:00:00.000Z',
);
const all = [older, newer, elsewhere, otherAcc];

const ask = (full: Partial<RoomAsk['full']>, passId: PassId | null = pass): RoomAsk => ({
  accountId: account,
  passId,
  full: { global: false, account: false, pass: false, ...full },
});

describe('laneToYield', () => {
  it.each<{ name: string; warm: WarmLane[]; ask: RoomAsk; yields: WarmLane | null }>([
    { name: 'nothing full', warm: all, ask: ask({}), yields: null },
    {
      name: 'the daemon-wide cap: the longest idle anywhere',
      warm: all,
      ask: ask({ global: true }),
      yields: otherAcc,
    },
    {
      name: "the account's limit: the longest idle on it",
      warm: all,
      ask: ask({ account: true }),
      yields: elsewhere,
    },
    {
      name: "the pass's page cap: the longest idle of the pass",
      warm: all,
      ask: ask({ pass: true }),
      yields: older,
    },
    {
      name: 'ordinary work at the account limit: a pass session yields',
      warm: all,
      ask: ask({ account: true }, null),
      yields: elsewhere,
    },
    {
      name: 'the page cap full for ordinary work: nothing a pass holds frees it',
      warm: all,
      ask: ask({ pass: true }, null),
      yields: null,
    },
    {
      name: 'the account and the page cap: only a lane counted in both',
      warm: [elsewhere, newer, otherAcc],
      ask: ask({ account: true, pass: true }),
      yields: newer,
    },
    { name: 'no warm session', warm: [], ask: ask({ global: true }), yields: null },
  ])('$name', ({ warm, ask: room, yields }) => {
    expect(laneToYield(warm, room)).toBe(yields?.id ?? null);
  });
});
