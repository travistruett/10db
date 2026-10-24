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

const SHA = '0123456789abcdef0123456789abcdef01234567';

describe('prBody', () => {
  it('gives each task its description and criteria, cites what they name, and links CI for the head', () => {
    const id = mintId('Batch');
    const body = prBody({
      batch: { id },
      tasks: [
        {
          title: 'Alpha',
          description: 'Reword spec §8.1 to match decision 36.',
          acceptanceCriteria: [
            'Claims are released on DONE, CANCELLED or FAILED.',
            'Nothing says a lease expiry releases a claim.',
          ],
          state: 'DONE',
        },
        {
          title: 'Beta',
          description: 'Check the greeting copy against open item 3.',
          acceptanceCriteria: ['it works'],
          state: 'FAILED',
        },
        { title: 'Gamma', description: '', acceptanceCriteria: ['it works'], state: 'CANCELLED' },
      ],
      gate: { command: 'make gate' },
      ci: { repo: 'acme/widgets', sha: SHA },
      template: null,
    });
    expect(body).toBe(
      [
        '## What and why',
        '',
        '### Alpha',
        '',
        'Reword spec §8.1 to match decision 36.',
        '',
        'Acceptance criteria:',
        '',
        '- Claims are released on DONE, CANCELLED or FAILED.',
        '- Nothing says a lease expiry releases a claim.',
        '',
        '### Beta',
        '',
        'Check the greeting copy against open item 3.',
        '',
        'Acceptance criteria:',
        '',
        '- it works',
        '',
        '### Gamma',
        '',
        'Acceptance criteria:',
        '',
        '- it works',
        '',
        'Not done:',
        '',
        '- Beta (failed)',
        '- Gamma (cancelled)',
        '',
        '## How it was checked',
        '',
        'Gate, run on the branch before the push:',
        '',
        '```',
        'make gate',
        '```',
        '',
        `CI run for the pushed head: [0123456](https://github.com/acme/widgets/commit/${SHA}/checks)`,
        '',
        '---',
        '',
        `Shipped by 10db, batch ${id}`,
        '',
      ].join('\n'),
    );
  });

  it('fills the sections of the repo pull request template and keeps its checklist', () => {
    const id = mintId('Batch');
    const body = prBody({
      batch: { id },
      tasks: [
        {
          title: 'Alpha',
          description: 'Says hello.',
          acceptanceCriteria: ['It greets.'],
          state: 'DONE',
        },
      ],
      gate: { command: 'make gate' },
      ci: { repo: 'acme/widgets', sha: SHA },
      template: [
        '## What and why',
        '',
        '<!-- What this changes and why. -->',
        '',
        '## How it was checked',
        '',
        '<!-- Commands you ran. -->',
        '',
        '## Checklist',
        '',
        '- [ ] `make gate` prints `GATE PASS`.',
        '',
      ].join('\n'),
    });
    expect(body).toBe(
      [
        '## What and why',
        '',
        '### Alpha',
        '',
        'Says hello.',
        '',
        'Acceptance criteria:',
        '',
        '- It greets.',
        '',
        '## How it was checked',
        '',
        'Gate, run on the branch before the push:',
        '',
        '```',
        'make gate',
        '```',
        '',
        `CI run for the pushed head: [0123456](https://github.com/acme/widgets/commit/${SHA}/checks)`,
        '',
        '## Checklist',
        '',
        '- [ ] `make gate` prints `GATE PASS`.',
        '',
        '---',
        '',
        `Shipped by 10db, batch ${id}`,
        '',
      ].join('\n'),
    );
  });

  it('never says the gate exited 0, since CI is the check the reviewer reads', () => {
    const body = prBody({
      batch: { id: mintId('Batch') },
      tasks: [{ title: 'Alpha', description: '', acceptanceCriteria: ['it works'], state: 'DONE' }],
      gate: { command: 'make gate' },
      ci: { repo: 'acme/widgets', sha: SHA },
      template: null,
    });
    expect(body).not.toContain('Exited');
    expect(body).toContain(`/commit/${SHA}/checks`);
  });
});
