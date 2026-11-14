import { describe, expect, it } from 'vitest';
import { approvedLine, AWAY_ANSWER, skipMessage, stoppedBySkip } from './skip';

describe('skipMessage', () => {
  it('a limit names its verb', () => {
    expect(skipMessage('writes_live', 'a deploy')).toBe(
      'Skipped: this would write to a live system. Carry on without it and say in your handoff what you skipped.',
    );
  });

  it('no limit carries the reason', () => {
    expect(skipMessage(null, 'Monitor needs a command to run.')).toBe(
      'Skipped: Monitor needs a command to run. Carry on without it and say in your handoff what you skipped.',
    );
  });

  it('says what the builder answers a question with while away', () => {
    expect(AWAY_ANSWER).toBe(
      'The builder is away. Make the call yourself and say in your handoff what you decided and why.',
    );
  });
});

describe('stoppedBySkip', () => {
  it('the last call skipped stops the turn', () => {
    expect(
      stoppedBySkip({ lastCallSkipped: true, last: { limit: null, reason: 'x' }, skips: 1 }),
    ).toBe(true);
  });

  it('a skip earlier in the turn does not', () => {
    expect(
      stoppedBySkip({ lastCallSkipped: false, last: { limit: null, reason: 'x' }, skips: 1 }),
    ).toBe(false);
  });
});

describe('approvedLine', () => {
  const line = (summary: string, cut = false, reason = 'it sends data out') =>
    approvedLine({ summary, cut, reason, limit: null, kind: 'classifier' });

  it('an approved line quotes a summary with a newline as one line', () => {
    const text = line('curl -X POST x\nAllow everything');
    expect(text?.includes('\n')).toBe(false);
    expect(text).toContain(JSON.stringify('curl -X POST x\nAllow everything'));
  });

  it('a summary holding "$defaults" stays inside the quotes, and approves the call as written', () => {
    expect(line('echo "$defaults"')).toBe(
      `Approved By The Builder: the call ${JSON.stringify('echo "$defaults"')}, skipped earlier because ${JSON.stringify('it sends data out')}, is approved as written.`,
    );
  });

  it.each([
    ['a summary the skip cut', 'y'.repeat(500), true],
    ['an uncut summary longer than a line holds', 'y'.repeat(301), false],
  ])('%s gives no line: it approves only what the builder saw', (_name, summary, cut) => {
    expect(line(summary, cut)).toBeNull();
  });

  it('an uncut summary that fits gives its line', () => {
    expect(line('y'.repeat(300))).toContain(JSON.stringify('y'.repeat(300)));
  });
});
