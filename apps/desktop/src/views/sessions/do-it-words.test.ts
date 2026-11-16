import { mintId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { parseRefusalLink } from './do-it-words';

const project = mintId('Project');
const chat = mintId('Chat');

describe('parseRefusalLink', () => {
  it.each([
    {
      name: 'a workbench link',
      link: `workbench:${project}`,
      want: { kind: 'workbench', projectId: project },
    },
    { name: 'a board link', link: `board:${project}`, want: { kind: 'board', projectId: project } },
    { name: 'a session link', link: `session:${chat}`, want: { kind: 'session', chatId: chat } },
    { name: 'no link', link: null, want: null },
    { name: 'an unknown kind', link: `inbox:${project}`, want: null },
    { name: 'a project link that is not a project id', link: 'board:not-an-id', want: null },
    { name: 'a session link that names a project', link: `session:${project}`, want: null },
    { name: 'a workbench link that names a chat', link: `workbench:${chat}`, want: null },
  ])('reads $name', ({ link, want }) => {
    expect(parseRefusalLink(link)).toEqual(want);
  });
});
