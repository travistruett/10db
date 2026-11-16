import { ConversationItemKind, type ProjectDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { areasOfChat, editedPathsOf } from './chat-areas';

// Do It's separate copy takes the areas the chat changed, else the catch-all, else the first area.

const areas: ProjectDto['areas'] = [
  { name: 'api', globs: ['src/api/**'] },
  { name: 'ui', globs: ['src/ui/**'] },
  { name: 'rest', globs: ['**'], catchAll: true },
];
const project = { areas, hazards: [] };

describe('areasOfChat', () => {
  it.each([
    { name: 'an edit under api', paths: ['src/api/a.ts'], expected: ['api'] },
    {
      name: 'edits and files in two areas, in the project’s order',
      paths: ['src/ui/b.tsx', 'src/api/a.ts', 'src/api/c.ts'],
      expected: ['api', 'ui'],
    },
    {
      name: 'a file in no named area falls to the catch-all',
      paths: ['README.md'],
      expected: ['rest'],
    },
    { name: 'no path at all falls to the catch-all', paths: [], expected: ['rest'] },
  ])('$name', ({ paths, expected }) => {
    expect(areasOfChat(project, paths)).toEqual(expected);
  });

  it('takes the first area when the project has no catch-all, and none when it has no area', () => {
    expect(areasOfChat({ areas: areas.slice(0, 2), hazards: [] }, [])).toEqual(['api']);
    expect(areasOfChat({ areas: [], hazards: [] }, ['a.ts'])).toEqual([]);
  });
});

describe('editedPathsOf', () => {
  const call = (path: string, status = 'done', kind = 'edit') => ({
    kind: ConversationItemKind.ToolCall,
    body: {
      id: 'c',
      harnessTool: 'Edit',
      status,
      title: 't',
      startedAt: '2026-11-16T00:00:00.000Z',
      durationMs: null,
      parentId: null,
      refusal: null,
      deniedBy: null,
      limit: null,
      soft: null,
      kind,
      path,
      change: 'update',
      movePath: null,
      hunks: [],
      addedLines: 1,
      removedLines: 0,
      truncated: false,
    },
  });

  it('keeps done edits inside the checkout, relative, once each', () => {
    const items = [
      call('/repo/src/api/a.ts'),
      call('/repo/src/api/a.ts'),
      call('src/ui/b.tsx'),
      call('/elsewhere/x.ts'),
      call('/repo/src/api/denied.ts', 'denied'),
    ];
    expect(editedPathsOf(items, '/repo')).toEqual(['src/api/a.ts', 'src/ui/b.tsx']);
  });
});
