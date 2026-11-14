import { describe, expect, it } from 'vitest';
import { dueTimers, type TimedSend } from './timers';

const HOUR = 3_600_000;
const START = Date.parse('2026-11-12T08:00:00.000Z');
const at = (hours: number): string => new Date(START + hours * HOUR).toISOString();
const clockAt = (hours: number): Date => new Date(START + hours * HOUR);

const waiting = (over: Partial<TimedSend> = {}): TimedSend => ({
  waitStartedAt: at(0),
  remindedAt: null,
  returnedAt: null,
  loneReplyPendingSince: null,
  approvalSeenAt: null,
  ...over,
});
const standard = { remindAfterHours: 4, returnAfterHours: 8 } as const;

describe('dueTimers', () => {
  it.each([
    ['3h59m: nothing', waiting(), standard, 3.98, 'none'],
    ['4h: remind', waiting(), standard, 4, 'remind'],
    ['reminded at 4h, 7h59m: nothing', waiting({ remindedAt: at(4) }), standard, 7.98, 'none'],
    ['8h: return', waiting({ remindedAt: at(4) }), standard, 8, 'return'],
    ['asleep from 1h to 9h: return, no reminder', waiting(), standard, 9, 'return'],
    [
      'reminder off, 5h: nothing',
      waiting(),
      { remindAfterHours: null, returnAfterHours: 8 },
      5,
      'none',
    ],
    [
      'reminder off, 8h: return',
      waiting(),
      { remindAfterHours: null, returnAfterHours: 8 },
      8,
      'return',
    ],
    [
      'a Keep Waiting at 9h: nothing at 12h',
      waiting({ waitStartedAt: at(9) }),
      standard,
      12,
      'none',
    ],
    [
      'a Keep Waiting at 9h: remind at 13h',
      waiting({ waitStartedAt: at(9) }),
      standard,
      13,
      'remind',
    ],
    [
      'a Keep Waiting at 9h: return at 17h',
      waiting({ waitStartedAt: at(9), remindedAt: at(13) }),
      standard,
      17,
      'return',
    ],
    [
      'a setting of 2h reminds at 2h',
      waiting(),
      { remindAfterHours: 2, returnAfterHours: 8 },
      2,
      'remind',
    ],
    ['already returned: nothing at 9h', waiting({ returnedAt: at(8) }), standard, 9, 'none'],
    ['already returned: nothing at 10h, 20h', waiting({ returnedAt: at(8) }), standard, 20, 'none'],
    [
      'the 3h to 10h jump returns once, then nothing',
      waiting({ returnedAt: at(10) }),
      standard,
      10.02,
      'none',
    ],
  ] as const)('%s', (_name, send, timers, hours, due) => {
    expect(dueTimers(send, timers, clockAt(hours))).toBe(due);
  });

  describe('a lone reply waiting for its quiet tick holds the timer one tick', () => {
    it.each([
      ['a return', waiting({ loneReplyPendingSince: at(7.98) }), 8, 'none'],
      ['the return, a minute later', waiting({ loneReplyPendingSince: at(7.98) }), 8.01, 'none'],
      [
        'the return, once the hold has run out',
        waiting({ loneReplyPendingSince: at(7.98) }),
        8.05,
        'return',
      ],
      [
        'a reply first seen after the return came due',
        waiting({ loneReplyPendingSince: at(8.01) }),
        8.02,
        'return',
      ],
      ['a reminder', waiting({ loneReplyPendingSince: at(3.99) }), 4, 'none'],
      ['a reminder, after the hold', waiting({ loneReplyPendingSince: at(3.99) }), 4.05, 'remind'],
    ] as const)('%s', (_name, send, hours, due) => {
      expect(dueTimers(send, standard, clockAt(hours))).toBe(due);
    });
  });

  it('holds the return one tick while an approval waits to be confirmed', () => {
    const approving = waiting({ approvalSeenAt: at(7.98) });
    expect(dueTimers(approving, standard, clockAt(8))).toBe('none');
    expect(dueTimers(approving, standard, clockAt(8.05))).toBe('return');
  });
});
