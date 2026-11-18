import { mintId, type ProjectId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { chatDto } from '../../test/chat-fixtures';
import type { FreshTab } from './fresh-tabs';
import { panelGroups, panelOrder } from './panel-order';

const a = mintId('Project');
const b = mintId('Project');
const gone = mintId('Project');

const fresh = (id: string, projectId: ProjectId, position = 0): FreshTab => ({
  id,
  projectId,
  model: null,
  effort: null,
  position,
});

const keys = (groups: ReturnType<typeof panelGroups>) =>
  panelOrder(groups).map((row) => (row.kind === 'chat' ? row.chat.title : `fresh:${row.tab.id}`));

describe('panelGroups and panelOrder', () => {
  const rows: readonly {
    readonly name: string;
    readonly projects: readonly ProjectId[];
    readonly chats: readonly Parameters<typeof chatDto>[0][];
    readonly fresh: readonly FreshTab[];
    readonly want: readonly string[];
  }[] = [
    {
      name: 'projects follow the list, not the selection or the chats',
      projects: [a, b],
      chats: [
        { title: 'B1', projectId: b, tabPosition: 0 },
        { title: 'A1', projectId: a, tabPosition: 5 },
      ],
      fresh: [],
      want: ['A1', 'B1'],
    },
    {
      name: 'a project’s sessions go by tabPosition',
      projects: [a],
      chats: [
        { title: 'second', projectId: a, tabPosition: 2 },
        { title: 'first', projectId: a, tabPosition: 1 },
      ],
      fresh: [],
      want: ['first', 'second'],
    },
    {
      name: 'a fresh row sits above its project’s sessions and below nothing else',
      projects: [a, b],
      chats: [
        { title: 'A1', projectId: a, tabPosition: 0 },
        { title: 'B1', projectId: b, tabPosition: 0 },
      ],
      fresh: [fresh('x', b)],
      want: ['A1', 'fresh:x', 'B1'],
    },
    {
      name: 'a project with no rows has no group',
      projects: [a, b],
      chats: [{ title: 'B1', projectId: b, tabPosition: 0 }],
      fresh: [],
      want: ['B1'],
    },
    {
      name: 'a removed project’s sessions follow the listed ones',
      projects: [a],
      chats: [
        { title: 'Orphan', projectId: gone, tabPosition: 0 },
        { title: 'A1', projectId: a, tabPosition: 0 },
      ],
      fresh: [],
      want: ['A1', 'Orphan'],
    },
  ];
  it.each(rows)('$name', ({ projects, chats, fresh: tabs, want }) => {
    const groups = panelGroups(
      projects.map((id) => ({ id })),
      chats.map((c) => chatDto(c)),
      tabs,
    );
    expect(keys(groups)).toEqual(want);
  });
});
