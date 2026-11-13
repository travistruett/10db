import { InvalidError } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { proposalCardBody, proposalFiling, taskFieldsFromProposal } from './proposal-task';

/** The kinds the builder has; the first four ask for a card, as the seeded ones do. */
const KNOWN = [
  { key: 'security', toInbox: true },
  { key: 'auth', toInbox: true },
  { key: 'migration', toInbox: true },
  { key: 'dependency', toInbox: true },
  { key: 'payments', toInbox: true },
  { key: 'ui', toInbox: false },
] as const;

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
    known: KNOWN,
  } as const;

  it('files a small new-task proposal with no kind that needs a card by itself', () => {
    expect(proposalFiling({ ...small, limit: 1200 })).toEqual({ file: true });
  });

  it('files one exactly at the limit and sends one a character over', () => {
    const at = { ...small, title: 'ab', body: 'cd' };
    expect(proposalFiling({ ...at, limit: 4 })).toEqual({ file: true });
    expect(proposalFiling({ ...at, limit: 3 })).toEqual({
      file: false,
      reason: 'it is over the limit for filing by itself',
    });
  });

  it('sends every proposal to the Inbox when the limit is zero', () => {
    expect(proposalFiling({ ...small, limit: 0 })).toEqual({
      file: false,
      reason: 'filing small proposals by itself is off for this project',
    });
  });

  it.each(['security', 'auth', 'migration', 'dependency'] as const)(
    'raises a card for a proposal that declares the %s kind',
    (tag) => {
      expect(proposalFiling({ ...small, kinds: [tag], limit: 1200 })).toEqual({
        file: false,
        reason: `it carries the ${tag} kind`,
      });
    },
  );

  it('names every declared kind', () => {
    expect(proposalFiling({ ...small, kinds: ['security', 'auth'], limit: 1200 })).toEqual({
      file: false,
      reason: 'it carries the security and auth kinds',
    });
    expect(
      proposalFiling({ ...small, kinds: ['security', 'auth', 'migration'], limit: 1200 }),
    ).toEqual({
      file: false,
      reason: 'it carries the security, auth and migration kinds',
    });
  });

  it('names the declared kinds when the limit is zero', () => {
    expect(proposalFiling({ ...small, kinds: ['security'], limit: 0 })).toEqual({
      file: false,
      reason:
        'it carries the security kind, and filing small proposals by itself is off for this project',
    });
  });

  describe('what the builder’s own kinds change', () => {
    it('raises a card for a custom kind that asks for one, naming it', () => {
      expect(proposalFiling({ ...small, kinds: ['payments'], limit: 1200 })).toEqual({
        file: false,
        reason: 'it carries the payments kind',
      });
    });

    it.each([
      { name: 'a declared kind that asks for no card', kinds: ['ui'], title: small.title },
      { name: 'a declared key no kind has', kinds: ['gone'], title: small.title },
    ])('files $name by itself', ({ kinds, title }) => {
      expect(proposalFiling({ ...small, title, kinds, limit: 1200 })).toEqual({ file: true });
    });

    it('names only the declared kinds that ask for a card when it also declares one that does not', () => {
      expect(proposalFiling({ ...small, kinds: ['ui', 'auth'], limit: 1200 })).toEqual({
        file: false,
        reason: 'it carries the auth kind',
      });
    });

    it('ignores a risk word whose kind asks for no card, or that the builder deleted', () => {
      const known = KNOWN.map((k) => (k.key === 'security' ? { ...k, toInbox: false } : k));
      expect(
        proposalFiling({ ...small, known, title: 'Tighten the security check', limit: 1200 }),
      ).toEqual({ file: true });
      expect(
        proposalFiling({
          ...small,
          known: KNOWN.filter((k) => k.key !== 'security'),
          title: 'Tighten the security check',
          limit: 1200,
        }),
      ).toEqual({ file: true });
    });
  });

  describe('a risk both declared and named in the text', () => {
    it('states a declared risk once', () => {
      expect(
        proposalFiling({
          ...small,
          title: 'Tighten the security check',
          kinds: ['security'],
          limit: 1200,
        }),
      ).toEqual({ file: false, reason: 'it carries the security kind' });
    });

    it('names a risk in the text that was not declared, and not the declared one', () => {
      expect(
        proposalFiling({
          ...small,
          title: 'Tighten the security and auth checks',
          kinds: ['security'],
          limit: 1200,
        }),
      ).toEqual({
        file: false,
        reason: 'it carries the security kind, and it names the auth risk',
      });
    });

    it('names every undeclared risk the text mentions', () => {
      expect(
        proposalFiling({
          ...small,
          title: 'Auth migration for the zod dependency',
          limit: 1200,
        }),
      ).toEqual({ file: false, reason: 'it names the auth, migration and dependency risks' });
      expect(
        proposalFiling({
          ...small,
          title: 'Auth migration for the zod dependency',
          kinds: ['migration'],
          limit: 1200,
        }),
      ).toEqual({
        file: false,
        reason: 'it carries the migration kind, and it names the auth and dependency risks',
      });
    });

    it('names the text risks when the limit is zero or the kind is change_task', () => {
      expect(
        proposalFiling({
          ...small,
          title: 'Tighten the security and auth checks',
          kinds: ['security'],
          limit: 0,
        }),
      ).toEqual({
        file: false,
        reason:
          'it carries the security kind, and filing small proposals by itself is off for this project, and it names the auth risk',
      });
      expect(
        proposalFiling({
          ...small,
          kind: 'change_task',
          title: 'Tighten the security and auth checks',
          kinds: ['security'],
          limit: 1200,
        }),
      ).toEqual({
        file: false,
        reason:
          'it carries the security kind, and it is not a new task, and it names the auth risk',
      });
    });
  });

  // A principle proposal takes its own path to the card: mcp.test.ts covers its tags.
  it.each(['change_task', 'note'] as const)('names the declared kinds of a %s proposal', (kind) => {
    expect(proposalFiling({ ...small, kind, kinds: ['security', 'auth'], limit: 1200 })).toEqual({
      file: false,
      reason: 'it carries the security and auth kinds, and it is not a new task',
    });
  });

  describe('past the step cap', () => {
    const capped = { ...small, limit: 1200, stepCapReached: true };

    it('names the declared kinds, not the cap', () => {
      expect(proposalFiling({ ...capped, kinds: ['auth'] })).toEqual({
        file: false,
        reason: 'it carries the auth kind',
      });
    });

    it('names a risk in the text, not the cap', () => {
      expect(proposalFiling({ ...capped, title: 'Check the auth token path' })).toEqual({
        file: false,
        reason: 'it names the auth risk',
      });
    });

    it('names a request to join a running batch, not the cap', () => {
      expect(proposalFiling({ ...capped, joinsRunningBatch: true })).toEqual({
        file: false,
        reason: 'it asks to join a running batch',
      });
    });

    it('names an oversize body, not the cap', () => {
      expect(proposalFiling({ ...capped, body: 'x'.repeat(1300) })).toEqual({
        file: false,
        reason: 'it is over the limit for filing by itself',
      });
    });

    it('names a limit of zero, not the cap', () => {
      expect(proposalFiling({ ...capped, limit: 0 })).toEqual({
        file: false,
        reason: 'filing small proposals by itself is off for this project',
      });
    });

    it('names the cap for a proposal that would otherwise be filed', () => {
      expect(proposalFiling(capped)).toEqual({
        file: false,
        reason: 'this step has already filed as many tasks as a step may, so a person decides',
      });
      expect(proposalFiling({ ...capped, stepCapReached: false })).toEqual({ file: true });
    });
  });

  it.each([
    ['Bump the zod dependency', 'dependency'],
    ['Add a migration for the column', 'migration'],
    ['Check the auth token path', 'auth'],
    ['Escape the path: a security gap', 'security'],
  ])('raises a card when the text names a risk: %s', (title, tag) => {
    expect(proposalFiling({ ...small, title, limit: 1200 })).toEqual({
      file: false,
      reason: `it names the ${tag} risk`,
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
      reason: 'it asks to join a running batch',
    });
  });

  it.each(['change_task', 'principle', 'note'] as const)(
    'never files a %s proposal by itself',
    (kind) => {
      expect(proposalFiling({ ...small, kind, limit: 1200 })).toEqual({
        file: false,
        reason: 'it is not a new task',
      });
    },
  );

  it('puts the reason on the card body after the proposal text', () => {
    expect(proposalCardBody('Why.', 'it carries the auth kind')).toBe(
      'Why.\n\nRaised as a card because it carries the auth kind.',
    );
  });
});
