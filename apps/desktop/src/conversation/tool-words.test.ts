import type { ToolCallView } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import {
  commandCall,
  editCall,
  mcpCall,
  otherCall,
  readCall,
  searchCall,
  subagentCall,
  toolEntry,
  webCall,
} from '../test/tool-call-fixtures';
import { editGroupWords, formatDuration, groupWords, toolRowWords } from './tool-words';

type Words = ReturnType<typeof toolRowWords>;

describe('toolRowWords', () => {
  it.each<[string, ToolCallView, Partial<Words>]>([
    [
      'command done',
      commandCall(),
      {
        verb: 'Ran',
        target: 'pnpm vitest run src/api',
        meta: '9 s',
        tone: 'dimmed',
        icon: 'terminal',
        name: 'Ran pnpm vitest run src/api, 9 seconds',
      },
    ],
    [
      'command failed',
      commandCall({ status: 'failed', exitCode: 1 }),
      {
        meta: 'exit 1 · 9 s',
        tone: 'red',
        name: 'Ran pnpm vitest run src/api, failed, exit 1, 9 seconds',
      },
    ],
    [
      'command running',
      commandCall({ status: 'running', durationMs: null, exitCode: null }),
      { verb: 'Running', meta: null, name: 'Running pnpm vitest run src/api' },
    ],
    [
      'edit update',
      editCall(),
      {
        icon: 'pencil',
        verb: 'Edited',
        target: 'src/api/client.ts',
        meta: '+4 −2',
        name: 'Edited src/api/client.ts, +4 −2',
      },
    ],
    [
      'edit add',
      editCall({ change: 'add', addedLines: 3, removedLines: 0 }),
      { verb: 'Created', meta: '+3 −0' },
    ],
    [
      'edit delete',
      editCall({ change: 'delete', addedLines: 0, removedLines: 5 }),
      { verb: 'Deleted', meta: '+0 −5' },
    ],
    [
      'edit move',
      editCall({ change: 'move', path: 'a', movePath: 'b' }),
      { verb: 'Moved', target: 'a', meta: 'to b', name: 'Moved a to b' },
    ],
    [
      'read',
      readCall(),
      { icon: 'file', verb: 'Read', target: 'src/router.tsx', name: 'Read src/router.tsx' },
    ],
    ['search', searchCall(), { icon: 'search', verb: 'Searched for', target: 'retry' }],
    [
      'mcp',
      mcpCall(),
      {
        icon: 'plug',
        verb: 'github · get_pr',
        target: '{"number":12}',
        tone: 'dimmed',
        name: 'github · get_pr: {"number":12}',
      },
    ],
    ['mcp failed', mcpCall({ status: 'failed', error: 'not found' }), { tone: 'red' }],
    [
      'subagent',
      subagentCall(),
      {
        icon: 'hierarchy',
        verb: 'Subagent:',
        target: 'find the retry code',
        meta: '0 calls · 1 min',
      },
    ],
    ['subagent with a model', subagentCall({ model: 'opus' }), { meta: '0 calls · 1 min · opus' }],
    [
      'web query',
      webCall(),
      {
        icon: 'world',
        verb: 'Searched the web for',
        target: '‘q’',
        name: 'Searched the web for ‘q’',
      },
    ],
    [
      'web url',
      webCall({ query: null, url: 'https://ok.example/a' }),
      { verb: 'Fetched', target: 'ok.example', name: 'Fetched ok.example' },
    ],
    [
      'other',
      otherCall(),
      { icon: 'tool', verb: 'Used propose_plan', target: 'x', name: 'Used propose_plan: x' },
    ],
    [
      'other, a Plan line',
      otherCall({
        title: 'propose_plan · 1 goal, 3 loose · passed',
        harnessTool: '10db.plan',
        name: '10db.plan',
        inputPreview: 'propose_plan · 1 goal, 3 loose · passed',
      }),
      {
        verb: 'Used propose_plan',
        target: '1 goal, 3 loose · passed',
        name: 'Used propose_plan: 1 goal, 3 loose · passed',
      },
    ],
    [
      'other, a title with no separator',
      otherCall({ title: 'see_screen', inputPreview: 'see_screen' }),
      { verb: 'Used see_screen', name: 'Used see_screen: see_screen' },
    ],
    [
      'denied by 10db',
      commandCall({ status: 'denied', deniedBy: '10db' }),
      {
        meta: '10db stopped this',
        tone: 'dimmed',
        name: 'Ran pnpm vitest run src/api, 10db stopped this',
      },
    ],
    [
      'denied with a refusal',
      commandCall({ status: 'denied', deniedBy: '10db', refusal: 'writes outside the checkout' }),
      {
        meta: '10db stopped this',
        name: 'Ran pnpm vitest run src/api, 10db stopped this, writes outside the checkout',
      },
    ],
    [
      'denied by the builder',
      commandCall({ status: 'denied', deniedBy: 'builder' }),
      { meta: 'You denied this', tone: 'dimmed' },
    ],
    [
      'denied by the judge at a limit',
      commandCall({ status: 'denied', deniedBy: 'judge', limit: 'sends_data_out', soft: true }),
      { meta: 'Held back: this would send data out', tone: 'dimmed' },
    ],
    [
      'denied by the judge at no named limit',
      commandCall({ status: 'denied', deniedBy: 'judge', soft: false }),
      { meta: 'Held back at a limit', tone: 'dimmed' },
    ],
    [
      'denied, by no one known',
      commandCall({ status: 'denied' }),
      { meta: null, tone: 'dimmed', name: 'Ran pnpm vitest run src/api, denied' },
    ],
  ])('%s', (_name, call, expected) => {
    expect(toolRowWords(call)).toMatchObject(expected);
  });

  it('counts the calls a subagent made', () => {
    expect(toolRowWords(subagentCall(), 3).meta).toBe('3 calls · 1 min');
    expect(toolRowWords(subagentCall(), 1).meta).toBe('1 call · 1 min');
  });
});

describe('groupWords', () => {
  const reads = (n: number) =>
    Array.from({ length: n }, (_, i) => toolEntry(readCall({ id: `r${String(i)}` })));
  const searches = (n: number) =>
    Array.from({ length: n }, (_, i) => toolEntry(searchCall({ id: `s${String(i)}` })));

  it.each([
    ['5 reads and 2 searches', [...reads(5), ...searches(2)], 'Read 5 files, searched 2 times'],
    ['1 read and 1 search', [...reads(1), ...searches(1)], 'Read 1 file, searched 1 time'],
    ['3 reads alone', reads(3), 'Read 3 files'],
    ['2 searches alone', searches(2), 'Searched 2 times'],
    [
      'a group still reading',
      [...reads(2), toolEntry(readCall({ id: 'live', status: 'running' }))],
      'Reading src/router.tsx',
    ],
  ])('%s', (_name, entries, text) => {
    expect(groupWords(entries)).toEqual({ text, name: text });
  });
});

describe('editGroupWords', () => {
  it('counts the files and their lines', () => {
    const entries = [
      toolEntry(editCall({ id: 'e1', addedLines: 10, removedLines: 2 })),
      toolEntry(editCall({ id: 'e2', addedLines: 20, removedLines: 0 })),
      toolEntry(editCall({ id: 'e3', addedLines: 10, removedLines: 10 })),
    ];
    expect(editGroupWords(entries)).toEqual({
      text: 'Edited 3 files · +40 −12',
      name: 'Edited 3 files, +40 −12',
    });
  });
});

describe('formatDuration', () => {
  it.each([
    [null, null],
    [0, '0 s'],
    [9_000, '9 s'],
    [59_400, '59 s'],
    [60_000, '1 min'],
    [720_000, '12 min'],
  ])('%s ms reads %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});
