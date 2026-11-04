import { InvalidError } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { proposalFiling, taskFieldsFromProposal } from './proposal-task';

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

describe('proposalFiling', () => {
  const small = {
    kind: 'new_task',
    title: 'Reword the criterion',
    body: 'It is unclear.',
  } as const;

  it('files a small new-task proposal with no risk tag by itself', () => {
    expect(proposalFiling({ ...small, limit: 1200 })).toEqual({ file: true });
  });

  it('files one exactly at the limit and sends one a character over', () => {
    const at = { ...small, title: 'ab', body: 'cd' };
    expect(proposalFiling({ ...at, limit: 4 })).toEqual({ file: true });
    expect(proposalFiling({ ...at, limit: 3 })).toEqual({ file: false, reason: 'over the limit' });
  });

  it('sends every proposal to the Inbox when the limit is zero', () => {
    expect(proposalFiling({ ...small, limit: 0 })).toEqual({
      file: false,
      reason: 'self-filing is off',
    });
  });

  it.each(['security', 'auth', 'migration', 'dependency'] as const)(
    'raises a card for a proposal that declares the %s risk tag',
    (tag) => {
      expect(proposalFiling({ ...small, riskTags: [tag], limit: 1200 })).toEqual({
        file: false,
        reason: `carries the ${tag} risk tag`,
      });
    },
  );

  it.each([
    ['Bump the zod dependency', 'dependency'],
    ['Add a migration for the column', 'migration'],
    ['Check the auth token path', 'auth'],
    ['Escape the path: a security gap', 'security'],
  ])('raises a card when the text names a risk: %s', (title, tag) => {
    expect(proposalFiling({ ...small, title, limit: 1200 })).toEqual({
      file: false,
      reason: `names the ${tag} risk`,
    });
  });

  it('does not take a word that merely contains a risk word for the risk', () => {
    expect(
      proposalFiling({ ...small, title: 'Author the unauthorised-name test', limit: 1200 }),
    ).toEqual({ file: true });
  });

  it('raises a card for a proposal that asks to join a running batch', () => {
    expect(proposalFiling({ ...small, joinsRunningBatch: true, limit: 1200 })).toEqual({
      file: false,
      reason: 'asks to join a running batch',
    });
  });

  it.each(['change_task', 'principle', 'note'] as const)(
    'never files a %s proposal by itself',
    (kind) => {
      expect(proposalFiling({ ...small, kind, limit: 1200 })).toEqual({
        file: false,
        reason: 'is not a new task',
      });
    },
  );
});
