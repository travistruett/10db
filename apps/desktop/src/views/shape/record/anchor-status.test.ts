import { mintId, type AnchorCheckDto, type PlanAnchor } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { anchorStatuses, checkStatus } from './anchor-status';

const CODE: PlanAnchor = {
  kind: 'code',
  path: 'apps/daemon/src/runner/runner.ts',
  line: 10,
  commit: '818d3644',
  excerpt: 'const pack = build();',
};
const URL_ANCHOR: PlanAnchor = {
  kind: 'url',
  url: 'https://tailscale.com/kb',
  readAt: '2026-11-12',
};

const check = (over: Partial<AnchorCheckDto>): AnchorCheckDto => ({
  entryKey: 'f1',
  entryVersion: 1,
  anchorIndex: 0,
  result: 'current',
  line: 10,
  checkedCommit: '0123456789abcdef',
  note: null,
  workstreamId: mintId('Workstream'),
  at: '2026-11-12T08:00:00.000Z',
  ...over,
});

describe('checkStatus', () => {
  it.each<[string, AnchorCheckDto | undefined, PlanAnchor, string, string]>([
    ['found at its line', check({}), CODE, 'Current', 'green'],
    ['found elsewhere', check({ result: 'moved', line: 40 }), CODE, 'Moved', 'yellow'],
    ['found nowhere', check({ result: 'changed', line: null }), CODE, 'Changed', 'red'],
    [
      'not read',
      check({ result: 'unchecked', line: null, note: 'over 4 MiB' }),
      CODE,
      'Not checked',
      'gray',
    ],
    ['no check yet', undefined, CODE, 'Not checked', 'gray'],
    ['a page read on a day', undefined, URL_ANCHOR, 'Read 12 Nov 2026', 'gray'],
  ])('%s', (_, c, anchor, label, color) => {
    expect(checkStatus(c, anchor)).toMatchObject({ label, color });
  });
});

describe('anchorStatuses', () => {
  it('reads each task newest check of this anchor, and never another anchor', () => {
    const taskId = mintId('Task');
    const statuses = anchorStatuses(CODE, 1, [
      { taskId, results: [check({ anchorIndex: 0 }), check({ anchorIndex: 1, result: 'moved' })] },
    ]);
    expect(statuses.map((s) => [s.taskId, s.status.label])).toEqual([[taskId, 'Moved']]);
  });

  it('says Not checked when no task checked it', () => {
    expect(anchorStatuses(CODE, 0, []).map((s) => [s.taskId, s.status.label])).toEqual([
      [null, 'Not checked'],
    ]);
  });
});
