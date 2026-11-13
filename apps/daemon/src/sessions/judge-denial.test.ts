import { LimitName } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { LIMIT_ORDER, LIMITS, type DeniedCall } from '../trust';
import { judgeDenial } from './judge-denial';

const denied = (over: Partial<DeniedCall>): DeniedCall => ({
  toolUseId: 't1',
  toolName: 'Bash',
  summary: 'x',
  reason: 'it gave no explanation',
  by: 'classifier',
  limit: null,
  ...over,
});

describe('judgeDenial', () => {
  it.each(LIMIT_ORDER.map((name) => [LIMITS[name].label, name] as const))(
    'a classifier denial at %s in an attended session is soft, at that limit',
    (label, name) => {
      expect(judgeDenial(denied({ reason: `Auto mode: [${label}]`, limit: name }), true)).toEqual({
        by: 'judge',
        reason: `Auto mode: [${label}]`,
        limit: name,
        soft: true,
      });
    },
  );

  it('a classifier denial naming no limit in an attended session is soft, as Allow this offers', () => {
    expect(judgeDenial(denied({}), true)).toEqual({
      by: 'judge',
      reason: 'it gave no explanation',
      limit: null,
      soft: true,
    });
  });

  it.each<[string, Partial<DeniedCall>, boolean]>([
    ['a reason that names no limit in a session no one is in', {}, false],
    [
      'a limit in a session no one is in, where limits are hard',
      { limit: LimitName.WritesLive },
      false,
    ],
    [
      'one of Claude Code’s safety checks',
      { by: 'safety_check', limit: LimitName.DestroysData },
      true,
    ],
  ])('%s is hard', (_name, over, attended) => {
    const call = denied(over);
    expect(judgeDenial(call, attended)).toEqual({
      by: 'judge',
      reason: call.reason,
      limit: call.by === 'classifier' ? call.limit : null,
      soft: false,
    });
  });
});
