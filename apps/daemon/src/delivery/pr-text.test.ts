import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mintId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { prBody, prTitle, titlePrefix } from './index';
import { parsePrScopes, scopeOf } from './pr-scopes';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** This repository's commitlint, as its commit-msg hook and pull request title check run it. */
function commitlint(title: string): { status: number | null; output: string } {
  const result = spawnSync(`${REPO_ROOT}node_modules/.bin/commitlint`, [], {
    cwd: REPO_ROOT,
    input: title,
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const task = (title: string) => ({ title });

describe('titlePrefix', () => {
  it.each([
    {
      name: 'one scope, a feature',
      tasks: [task('Add greetings')],
      scope: 'daemon',
      expected: 'feat(daemon)',
    },
    { name: 'no scope, a feature', tasks: [task('Add greetings')], scope: null, expected: 'feat' },
    {
      name: 'one scope, a fix',
      tasks: [task('Fix the greeting')],
      scope: 'desktop',
      expected: 'fix(desktop)',
    },
    { name: 'no scope, a fix', tasks: [task('fix the greeting')], scope: null, expected: 'fix' },
    {
      name: 'a title that says fixes',
      tasks: [task('Fixes a crash on start')],
      scope: null,
      expected: 'fix',
    },
    {
      name: 'every task a fix',
      tasks: [task('Fix the greeting'), task('Fix the farewell')],
      scope: 'docs',
      expected: 'fix(docs)',
    },
    {
      name: 'a feature with its review fixes is a feature',
      tasks: [task('Add greetings'), task('Fix the review findings')],
      scope: null,
      expected: 'feat',
    },
    {
      name: 'a word that only starts with fix',
      tasks: [task('Fixture loader')],
      scope: null,
      expected: 'feat',
    },
  ])('$name', ({ tasks, scope, expected }) => {
    expect(titlePrefix(tasks, scope)).toBe(expected);
  });
});

describe("this repository's scope list", () => {
  const scopes = parsePrScopes(readFileSync(`${REPO_ROOT}.10db/pr-scopes.json`, 'utf8'));

  it.each([
    {
      paths: ['apps/daemon/src/a.ts', 'apps/daemon/AGENTS.md'],
      expected: 'feat(daemon): add greetings',
    },
    { paths: ['apps/desktop/src/a.tsx'], expected: 'feat(desktop): add greetings' },
    { paths: ['packages/contracts/src/a.ts'], expected: 'feat(contracts): add greetings' },
    { paths: ['packages/db/src/a.ts'], expected: 'feat(db): add greetings' },
    { paths: ['packages/harness/a.md'], expected: 'feat(harness): add greetings' },
    {
      paths: ['tests/repo/src/a.test.ts', 'Makefile', '.10db/pr-scopes.json'],
      expected: 'feat(repo): add greetings',
    },
    { paths: ['.github/workflows/ci.yml'], expected: 'feat(ci): add greetings' },
    { paths: ['docs/a.md', 'README.md'], expected: 'feat(docs): add greetings' },
    { paths: ['apps/daemon/src/a.ts', 'docs/a.md'], expected: 'feat: add greetings' },
  ])('$paths gives "$expected", which its commitlint passes', ({ paths, expected }) => {
    const title = prTitle(
      titlePrefix([task('Add greetings')], scopeOf(paths, scopes)),
      'Add greetings',
    );
    expect(title).toBe(expected);
    const lint = commitlint(title);
    expect(lint.status, lint.output).toBe(0);
  });
});

describe('prTitle', () => {
  it.each([
    {
      name: 'a type and scope',
      prefix: 'feat(daemon)',
      title: 'Add greetings',
      expected: 'feat(daemon): add greetings',
    },
    {
      name: 'a type alone',
      prefix: 'fix',
      title: 'Fix the greeting',
      expected: 'fix: fix the greeting',
    },
    {
      name: 'quotes and $() kept as written',
      prefix: 'fix',
      title: 'Fix "quotes" and $(stuff)',
      expected: 'fix: fix "quotes" and $(stuff)',
    },
    {
      name: 'already lowercase',
      prefix: 'feat(desktop)',
      title: 'already lowercase',
      expected: 'feat(desktop): already lowercase',
    },
    {
      name: 'a trailing full stop dropped',
      prefix: 'feat',
      title: 'Add greetings.',
      expected: 'feat: add greetings',
    },
    {
      name: 'spaces around the title and its full stop dropped',
      prefix: 'feat',
      title: '  Add greetings .  ',
      expected: 'feat: add greetings',
    },
    {
      name: 'a project prefix used as written',
      prefix: 'chore(repo)',
      title: 'Tidy the scripts',
      expected: 'chore(repo): tidy the scripts',
    },
    {
      name: 'a title past the header limit cut at a word',
      prefix: 'feat(contracts)',
      title: `Add ${'many words '.repeat(12)}at the end`,
      expected: `feat(contracts): add ${'many words '.repeat(6)}many words`,
    },
  ])('$name', ({ prefix, title, expected }) => {
    const produced = prTitle(prefix, title);
    expect(produced).toBe(expected);
    expect(produced.length).toBeLessThanOrEqual(100);
    const lint = commitlint(produced);
    expect(lint.status, lint.output).toBe(0);
  });

  it("gives a title this repository's commitlint refuses when the prefix names an unlisted scope", () => {
    expect(commitlint(prTitle('feat(dameon)', 'Add greetings')).status).toBe(1);
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

  it('says each task was approved in 10db when the project has no gate command', () => {
    const body = prBody({
      batch: { id: mintId('Batch') },
      tasks: [{ title: 'Alpha', description: '', acceptanceCriteria: ['it works'], state: 'DONE' }],
      gate: { command: null },
      ci: { repo: 'acme/widgets', sha: SHA },
      template: null,
    });
    expect(body).toContain(
      [
        '## How it was checked',
        '',
        'No gate command: each task was approved in 10db.',
        '',
        `CI run for the pushed head: [0123456](https://github.com/acme/widgets/commit/${SHA}/checks)`,
      ].join('\n'),
    );
    expect(body).not.toContain('Gate, run on the branch');
  });

  it.each([
    { name: 'a task shipped anyway', states: ['DONE', 'FAILED'] },
    { name: 'a task still queued', states: ['QUEUED'] },
    { name: 'no tasks done at all', states: ['CANCELLED', 'FAILED'] },
  ] as const)('does not claim approval for $name when there is no gate command', ({ states }) => {
    const body = prBody({
      batch: { id: mintId('Batch') },
      tasks: states.map((state, i) => ({
        title: `Task ${String(i)}`,
        description: '',
        acceptanceCriteria: [],
        state,
      })),
      gate: { command: null },
      ci: { repo: 'acme/widgets', sha: SHA },
      template: null,
    });
    expect(body).toContain('## How it was checked\n\nNo gate command.\n\nCI run');
    expect(body).not.toContain('approved in 10db');
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
