import type { OutboundHit } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { holdFor, type HoldInput, type HoldRecipient } from './send-holds';

const who = (over: Partial<HoldRecipient> = {}): HoldRecipient => ({
  sendMode: 'auto',
  dailyLimit: 10,
  everSent: true,
  newThreads: 0,
  ...over,
});
const hold = (pattern: string): OutboundHit => ({ pattern, line: 1, severity: 'hold' });
const warn: OutboundHit = { pattern: 'file_path', line: 1, severity: 'warn' };

const input = (over: Partial<HoldInput> = {}): HoldInput => ({
  hits: [],
  recipients: [who()],
  thread: null,
  ...over,
});

describe('holdFor', () => {
  it.each([
    ['sends at once in auto mode after a first send', input(), null],
    ['a path only warns', input({ hits: [warn] }), null],
    [
      'a review-mode recipient waits',
      input({ recipients: [who({ sendMode: 'review' })] }),
      'review',
    ],
    [
      'the first send waits even in auto mode',
      input({ recipients: [who({ everSent: false })] }),
      'first_send',
    ],
    ['a url holds', input({ hits: [hold('url')] }), 'scan'],
    ['the tenth new thread sends', input({ recipients: [who({ newThreads: 9 })] }), null],
    ['the eleventh new thread waits', input({ recipients: [who({ newThreads: 10 })] }), 'limit'],
    [
      'no limit never waits on it',
      input({ recipients: [who({ dailyLimit: null, newThreads: 99 })] }),
      null,
    ],
    [
      'a tie waits when one recipient is on review',
      input({ recipients: [who(), who({ sendMode: 'review' })] }),
      'review',
    ],
    [
      'a tie waits when one recipient is at the limit',
      input({ recipients: [who(), who({ newThreads: 10 })] }),
      'limit',
    ],
    [
      'scan wins over first send, limit and review',
      input({
        hits: [hold('url')],
        recipients: [who({ everSent: false, newThreads: 10, sendMode: 'review' })],
      }),
      'scan',
    ],
    [
      'first send wins over limit and review',
      input({ recipients: [who({ everSent: false, newThreads: 10, sendMode: 'review' })] }),
      'first_send',
    ],
    [
      'limit wins over review',
      input({ recipients: [who({ newThreads: 10, sendMode: 'review' })] }),
      'limit',
    ],
    [
      'a follow-up in a reviewed thread skips review, first send and the limit',
      input({
        thread: { reviewed: true },
        recipients: [who({ sendMode: 'review', everSent: false, newThreads: 10 })],
      }),
      null,
    ],
    [
      'a follow-up in a reviewed thread is still stopped by a hold',
      input({ thread: { reviewed: true }, hits: [hold('code_block')] }),
      'scan',
    ],
    [
      'a follow-up in an unreviewed thread still waits for review but not the limit',
      input({
        thread: { reviewed: false },
        recipients: [who({ sendMode: 'review', newThreads: 10 })],
      }),
      'review',
    ],
    [
      'a follow-up in an unreviewed thread is not held by the limit',
      input({ thread: { reviewed: false }, recipients: [who({ newThreads: 10 })] }),
      null,
    ],
  ])('%s', (_name, given, held) => {
    expect(holdFor(given)).toBe(held);
  });
});
