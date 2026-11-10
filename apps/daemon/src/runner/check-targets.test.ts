import { mintId, TASK_MESSAGE_MAX_CHARS, type AreaDef } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { checkNoticeLine, checkOffer, checkTargets, type CheckPage } from './check-targets';

// Workbench spec §8.1, plan §3.1a: a failed check's output is free text. It names a task's page only
// by a whole path that differs from the pass's branch; anything else goes to the tasks whose turns
// ran the check, and the header always says it.

const areas: AreaDef[] = [
  { name: 'settings', globs: ['src/settings/**'], role: 'page', route: '/settings' },
  { name: 'people', globs: ['src/people/**'], role: 'page', route: '/people' },
  { name: 'src', globs: ['src/**'], role: 'shared' },
];
const settings = mintId('Task');
const people = mintId('Task');
const page = (taskId: CheckPage['taskId'], area: string, over: Partial<CheckPage> = {}) => ({
  taskId,
  areas: [area],
  signedOff: false,
  working: false,
  ...over,
});
const REPO = '/Users/me/app';
const changed = ['src/people/page.tsx', 'src/settings/page.tsx', 'src/shared.ts'];

describe('where a failed check goes', () => {
  it.each<{
    name: string;
    output: string;
    pages?: CheckPage[];
    ran?: CheckPage['taskId'][];
    named: string[];
    threads: { taskId: CheckPage['taskId']; paths: string[] }[];
  }>([
    {
      name: 'a changed path named whole goes to the page that holds it',
      output: 'error TS2322 in src/settings/page.tsx\n',
      named: ['src/settings/page.tsx'],
      threads: [{ taskId: settings, paths: ['src/settings/page.tsx'] }],
    },
    {
      name: 'a longer name is not the path: page.tsxx does not name page.tsx',
      output: 'src/settings/page.tsxx failed\n',
      named: [],
      threads: [{ taskId: people, paths: [] }],
    },
    {
      name: "a path under the folder's absolute path, after ./, or with a line and column",
      output: [
        `${REPO}/src/settings/page.tsx`,
        './src/people/page.tsx(3,1): error',
        'src/settings/page.tsx:12:3 - error',
      ].join('\n'),
      named: ['src/people/page.tsx', 'src/settings/page.tsx'],
      threads: [
        { taskId: settings, paths: ['src/settings/page.tsx'] },
        { taskId: people, paths: ['src/people/page.tsx'] },
      ],
    },
    {
      name: 'a path that ends a sentence, before a space or at the end',
      output: 'Fix src/settings/page.tsx. Then src/people/page.tsx.',
      named: ['src/people/page.tsx', 'src/settings/page.tsx'],
      threads: [
        { taskId: settings, paths: ['src/settings/page.tsx'] },
        { taskId: people, paths: ['src/people/page.tsx'] },
      ],
    },
    {
      name: 'a path under another directory is not the path',
      output: 'packages/web/src/settings/page.tsx:1:1 error',
      named: [],
      threads: [{ taskId: people, paths: [] }],
    },
    {
      name: 'a shared path has no owner, so it goes to the tasks whose turns ran the check',
      output: 'src/shared.ts:4:2 error',
      ran: [settings, people],
      named: ['src/shared.ts'],
      threads: [
        { taskId: settings, paths: [] },
        { taskId: people, paths: [] },
      ],
    },
    {
      name: 'a path of a signed-off page has no owner either',
      output: 'src/settings/page.tsx:1:1 error',
      pages: [page(settings, 'settings', { signedOff: true }), page(people, 'people')],
      named: ['src/settings/page.tsx'],
      threads: [{ taskId: people, paths: [] }],
    },
    {
      name: 'no path named goes to the tasks whose turns ran the check and are still held',
      output: 'Error: something broke\n',
      pages: [page(people, 'people')],
      ran: [settings, people],
      named: [],
      threads: [{ taskId: people, paths: [] }],
    },
    {
      name: 'a task whose page is working on its next turn is left out of the fallback',
      output: 'Error: something broke\n',
      pages: [page(settings, 'settings', { working: true }), page(people, 'people')],
      ran: [settings, people],
      named: [],
      threads: [{ taskId: people, paths: [] }],
    },
    {
      name: 'with none of them left, only the header says it',
      output: 'Error: something broke\n',
      pages: [page(settings, 'settings', { signedOff: true })],
      ran: [settings, people],
      named: [],
      threads: [],
    },
  ])('$name', ({ output, pages, ran, named, threads }) => {
    expect(
      checkTargets({
        output,
        changed,
        roots: [REPO],
        areas,
        pages: pages ?? [page(settings, 'settings'), page(people, 'people')],
        ran: ran ?? [people],
      }),
    ).toEqual({ named, threads });
  });
});

describe("a failed check's words", () => {
  it('names the paths on one line, or says it names none', () => {
    expect(checkNoticeLine(['src/settings/page.tsx', 'src/shared.ts'])).toBe(
      'Check failed: names `src/settings/page.tsx`, `src/shared.ts`',
    );
    expect(checkNoticeLine([])).toBe('Check failed after a turn: it names no changed file');
  });

  it("offers the command, its exit and the output's end, cut to what one message holds", () => {
    const tail = `${'early line\n'.repeat(4000)}the last error\n`;
    const offer = checkOffer({
      line: 'Check failed: names `src/settings/page.tsx`',
      command: 'make check-changed',
      exitCode: 2,
      output: tail,
    });
    const short = checkOffer({
      line: 'Check failed after a turn: it names no changed file',
      command: 'make check-changed',
      exitCode: 1,
      output: 'stuck\n',
    });

    expect(offer.length).toBeLessThanOrEqual(TASK_MESSAGE_MAX_CHARS);
    expect(offer.startsWith('Check failed: names `src/settings/page.tsx`\n\n')).toBe(true);
    expect(offer).toContain('`make check-changed` exited 2.');
    expect(offer.endsWith('the last error\n```')).toBe(true);
    expect(short).toBe(
      [
        'Check failed after a turn: it names no changed file',
        '',
        '`make check-changed` exited 1.',
        '',
        '```',
        'stuck',
        '```',
      ].join('\n'),
    );
  });
});
