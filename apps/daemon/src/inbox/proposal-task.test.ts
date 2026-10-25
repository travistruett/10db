import { InvalidError } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { taskFieldsFromProposal } from './proposal-task';

const words = (count: number) => Array.from({ length: count }, () => 'word').join(' ');

describe('taskFieldsFromProposal', () => {
  it.each([
    {
      name: 'a one-line title keeps the body as the description',
      proposal: { title: 'Add caching', body: 'Cache the query.' },
      expected: { title: 'Add caching', description: 'Cache the query.' },
    },
    {
      name: 'line breaks and tabs in the title become single spaces',
      proposal: { title: '  Add\n  caching\tlayer ', body: 'Body.' },
      expected: { title: 'Add caching layer', description: 'Body.' },
    },
    {
      name: 'a title over 200 characters is cut and its full text leads the description',
      proposal: { title: `${words(50)} end`, body: 'Body.' },
      expected: {
        title: words(40),
        description: `${words(50)} end\n\nBody.`,
      },
    },
  ])('$name', ({ proposal, expected }) => {
    expect(taskFieldsFromProposal(proposal)).toEqual(expected);
  });

  it('refuses a title that is only whitespace, since a task needs one', () => {
    expect(() => taskFieldsFromProposal({ title: ' \n\t ', body: 'Body.' })).toThrow(InvalidError);
  });
});
