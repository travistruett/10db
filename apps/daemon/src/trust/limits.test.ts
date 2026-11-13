import { LimitName } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { LIMIT_ORDER, LIMITS, limitOfDenial } from './limits';

describe('the limits', () => {
  it('every limit has a label and a sentence, in LIMIT_ORDER', () => {
    expect(LIMIT_ORDER.map((name) => LIMITS[name].label)).toEqual([
      "Destroying Data It Didn't Create",
      'Sending Data Out',
      'Reading Secrets',
      'Writing To Live Systems',
    ]);
    expect(new Set(LIMIT_ORDER)).toEqual(new Set(Object.values(LimitName)));
    for (const name of LIMIT_ORDER) expect(LIMITS[name].text.length).toBeGreaterThan(20);
  });

  it.each([
    ['null is null', null, null],
    [
      "L2's reason, which names no rule, is null",
      'The server-side auto mode classifier judged this action dangerous (it gave no explanation)',
      null,
    ],
    [
      'a reason naming Reading Secrets is reads_secrets',
      'Auto mode: [Reading Secrets]',
      'reads_secrets',
    ],
    ['a reason in another case is writes_live', 'blocked: writing to live systems', 'writes_live'],
    ["Claude Code's own rule is null", 'Data Exfiltration', null],
    ['a label inside a longer word is null', 'Reading Secretsauce', null],
  ])('%s', (_name, reason, limit) => {
    expect(limitOfDenial(reason)).toBe(limit);
  });
});
