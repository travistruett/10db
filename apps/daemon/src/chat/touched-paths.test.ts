import { EditChange, ToolCallKind, ToolCallStatus, type ToolCallView } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { touchedPaths } from './touched-paths';

const ROOT = '/work/app';

const common = {
  startedAt: '2026-11-17T10:00:00.000Z',
  durationMs: 5,
  parentId: null,
  refusal: null,
  deniedBy: null,
  limit: null,
  soft: null,
} as const;

const edit = (
  path: string,
  over: Partial<{ status: ToolCallStatus; change: EditChange; movePath: string | null }> = {},
): ToolCallView => ({
  ...common,
  id: `edit-${path}`,
  harnessTool: 'Edit',
  kind: ToolCallKind.Edit,
  status: over.status ?? ToolCallStatus.Done,
  title: path,
  path,
  change: over.change ?? EditChange.Update,
  movePath: over.movePath ?? null,
  hunks: [],
  addedLines: 1,
  removedLines: 0,
  truncated: false,
});

const read = (path: string): ToolCallView => ({
  ...common,
  id: `read-${path}`,
  harnessTool: 'Read',
  kind: ToolCallKind.Read,
  status: ToolCallStatus.Done,
  title: path,
  path,
  range: null,
});

describe('touchedPaths', () => {
  it.each<{ name: string; items: ToolCallView[]; want: string[] }>([
    { name: 'no calls', items: [], want: [] },
    {
      name: 'an allowed edit, as a path relative to the root',
      items: [edit(`${ROOT}/src/a.ts`)],
      want: ['src/a.ts'],
    },
    {
      name: 'a path already relative to the root',
      items: [edit('src/a.ts')],
      want: ['src/a.ts'],
    },
    {
      name: 'a denied edit is not a touch',
      items: [edit(`${ROOT}/src/a.ts`, { status: ToolCallStatus.Denied })],
      want: [],
    },
    {
      name: 'a failed edit is not a touch',
      items: [edit(`${ROOT}/src/a.ts`, { status: ToolCallStatus.Failed })],
      want: [],
    },
    {
      name: 'an edit still running is not a touch yet',
      items: [edit(`${ROOT}/src/a.ts`, { status: ToolCallStatus.Running })],
      want: [],
    },
    {
      name: 'a file outside the root is foreign',
      items: [edit('/elsewhere/b.ts'), edit(`${ROOT}-other/c.ts`)],
      want: [],
    },
    {
      name: 'a path that climbs out of the root is foreign',
      items: [edit(`${ROOT}/../b.ts`), edit('../b.ts')],
      want: [],
    },
    {
      name: 'a read is not a touch',
      items: [read(`${ROOT}/src/a.ts`)],
      want: [],
    },
    {
      name: 'the same file twice is listed once, sorted with the rest',
      items: [edit(`${ROOT}/z.ts`), edit(`${ROOT}/a.ts`), edit(`${ROOT}/z.ts`)],
      want: ['a.ts', 'z.ts'],
    },
    {
      name: 'a move names both ends',
      items: [edit(`${ROOT}/old.ts`, { change: EditChange.Move, movePath: `${ROOT}/new/old.ts` })],
      want: ['new/old.ts', 'old.ts'],
    },
    {
      name: 'a move to a foreign place keeps only the end inside',
      items: [edit(`${ROOT}/old.ts`, { change: EditChange.Move, movePath: '/elsewhere/old.ts' })],
      want: ['old.ts'],
    },
  ])('$name', ({ items, want }) => {
    expect(touchedPaths(items, ROOT)).toEqual(want);
  });
});
