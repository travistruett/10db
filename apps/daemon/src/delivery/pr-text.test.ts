import { mintId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { prBody, prTitle } from './index';

describe('prTitle', () => {
  it.each([
    { prefix: 'feat(app)', title: 'Add greetings', expected: 'feat(app): add greetings' },
    {
      prefix: 'fix',
      title: 'Fix "quotes" and $(stuff)',
      expected: 'fix: fix "quotes" and $(stuff)',
    },
    { prefix: 'feat(app)', title: 'already lowercase', expected: 'feat(app): already lowercase' },
    { prefix: null, title: 'No prefix', expected: 'no prefix' },
  ])('$prefix + "$title"', ({ prefix, title, expected }) => {
    expect(prTitle(prefix, title)).toBe(expected);
  });
});

describe('prBody', () => {
  it('lists every task with its final state, the gate, the unfinished tasks and the footer', () => {
    const id = mintId('Batch');
    const body = prBody({
      batch: { id, title: 'Greetings' },
      rows: [
        { title: 'Alpha', state: 'DONE' },
        { title: 'Beta', state: 'FAILED' },
        { title: 'Gamma', state: 'CANCELLED' },
      ],
      gate: { command: 'make gate', exitCode: 0 },
    });
    expect(body).toBe(
      [
        '## Greetings',
        '',
        '### Tasks',
        '',
        '- Alpha: done',
        '- Beta: failed',
        '- Gamma: cancelled',
        '',
        '### Gate',
        '',
        '```',
        'make gate',
        '```',
        '',
        'Exited 0 on the branch as pushed.',
        '',
        '### Not done',
        '',
        '- Beta (failed)',
        '- Gamma (cancelled)',
        '',
        '---',
        '',
        `Shipped by 10db, batch ${id}`,
        '',
      ].join('\n'),
    );
  });
});
