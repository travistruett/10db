import { mintId, type AccountId, type PassId, type ProjectId } from '@10db/contracts';
import type { LaneCounts } from '@10db/db';
import { describe, expect, it } from 'vitest';
import { roomForLane } from './lane-room';

// Workbench spec §5.2 (W11): a pass's lanes are outside its project's lane limit and inside the
// account's and the daemon's; they are held to the pass's page cap instead.

const project: ProjectId = mintId('Project');
const account: AccountId = mintId('Account');
const pass: PassId = mintId('Pass');
const CAPS = { global: 4, maxLanes: 2, accountCap: 4 };

function counts(use: {
  global: number;
  project?: number;
  account?: number;
  pass?: number;
}): LaneCounts {
  return {
    global: use.global,
    byProject: new Map([[project, use.project ?? 0]]),
    byAccount: new Map([[account, use.account ?? use.global]]),
    byPass: new Map([[pass, use.pass ?? 0]]),
  };
}

describe('roomForLane', () => {
  it.each<{
    name: string;
    use: Parameters<typeof counts>[0];
    inPass: boolean;
    room: boolean;
  }>([
    {
      name: 'an ordinary task under every limit',
      use: { global: 1, project: 1 },
      inPass: false,
      room: true,
    },
    {
      name: 'an ordinary task at its project limit',
      use: { global: 2, project: 2 },
      inPass: false,
      room: false,
    },
    {
      name: 'a pass task with its project at its limit',
      use: { global: 2, project: 2 },
      inPass: true,
      room: true,
    },
    { name: 'a pass task at its page cap', use: { global: 3, pass: 3 }, inPass: true, room: false },
    {
      name: 'a pass task at the account limit',
      use: { global: 3, account: 4, pass: 1 },
      inPass: true,
      room: false,
    },
    {
      name: 'a pass task at the daemon-wide cap',
      use: { global: 4, account: 3, pass: 1 },
      inPass: true,
      room: false,
    },
  ])('$name', ({ use, inPass, room }) => {
    expect(
      roomForLane(counts(use), {
        projectId: project,
        accountId: account,
        pass: inPass ? { id: pass, pageCap: 3 } : null,
        ...CAPS,
      }),
    ).toBe(room);
  });
});
