import { InboxItemDto, mintId, type InboxOption } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { composeSlackQuestion, escapeMrkdwn, stakeholderOptions } from './index';

const PARK: InboxOption = {
  label: 'Park the task',
  description: 'Stops this run and parks the task in the Icebox.',
};

function card(
  over: Partial<{
    title: string;
    body: string;
    options: InboxOption[];
    recommendation: string | null;
  }> = {},
) {
  return InboxItemDto.parse({
    id: mintId('InboxItem'),
    projectId: mintId('Project'),
    kind: 'question',
    state: 'OPEN',
    title: 'How long should a customer keep access while a failed renewal retries?',
    body: 'The spec says "retry and notify" but not how long the account stays active meanwhile.',
    options: [
      {
        label: 'Keep access for 7 days, retry on days 1, 3 and 7, then downgrade',
        description: 'Gentle on customers.',
      },
      { label: 'Cut access at once until payment succeeds', description: 'Strict.' },
      { label: 'Keep access for the whole billing period', description: 'Simplest.' },
      PARK,
    ],
    recommendation: 'Keep access for 7 days, retry on days 1, 3 and 7, then downgrade',
    category: 'product',
    urgency: 'normal',
    assignee: 'mark',
    detail: null,
    answer: null,
    targets: [],
    createdAt: '2026-11-12T10:00:00.000Z',
    updatedAt: '2026-11-12T10:00:00.000Z',
    ...over,
  });
}

const context = {
  projectName: 'Acme',
  goalTitle: 'Renewals' as string | null,
  builderName: 'Travis',
  recipientNames: ['Mark'],
};

describe('escapeMrkdwn', () => {
  it.each([
    ['ampersand first, so it is not escaped twice', 'a & b', 'a &amp; b'],
    [
      'angle brackets',
      '<!channel> <@U123> <https://x|y>',
      '&lt;!channel&gt; &lt;@U123&gt; &lt;https://x|y&gt;',
    ],
    ['backticks are dropped', 'run `rm -rf` now', 'run rm -rf now'],
    ['already-escaped text is escaped again, once', '&lt;', '&amp;lt;'],
    ['plain text is untouched', 'Keep access', 'Keep access'],
  ])('%s', (_name, input, expected) => {
    expect(escapeMrkdwn(input)).toBe(expected);
  });
});

describe('stakeholderOptions', () => {
  it('drops the park choice however it is cased and keeps the lane options in order', () => {
    const options = stakeholderOptions(
      card({
        options: [
          { label: 'A one', description: '' },
          { label: '  park THE task ', description: '' },
          { label: 'B two', description: '' },
        ],
      }),
    );
    expect(options.map((o) => o.label)).toEqual(['A one', 'B two']);
  });
});

describe('composeSlackQuestion', () => {
  it('renders the card exactly, ending with the reply instruction', () => {
    const { text, blocks } = composeSlackQuestion({ card: card(), ...context });
    expect(text).toBe(
      [
        "Travis's 10db build of *Renewals* has a question for you.",
        '',
        '*How long should a customer keep access while a failed renewal retries?*',
        'The spec says "retry and notify" but not how long the account stays active meanwhile.',
        '',
        '*A.* Keep access for 7 days, retry on days 1, 3 and 7, then downgrade  _(recommended)_',
        '*B.* Cut access at once until payment succeeds',
        '*C.* Keep access for the whole billing period',
        '',
        'The work on this waits for your answer.',
        'Reply with A, B, C, or your own words.',
      ].join('\n'),
    );
    expect(blocks.map((b) => b.text.text).join('\n\n')).toBe(text);
  });

  it('names the project when the task has no goal', () => {
    const { text } = composeSlackQuestion({ card: card(), ...context, goalTitle: null });
    expect(text.split('\n')[0]).toBe("Travis's 10db build of *Acme* has a question for you.");
  });

  it('with several recipients reads for Mark and Ana, and ends the same way', () => {
    const { text } = composeSlackQuestion({
      card: card(),
      ...context,
      recipientNames: ['Mark', 'Ana'],
    });
    expect(text.split('\n')[0]).toBe(
      "Travis's 10db build of *Renewals* has a question for Mark and Ana.",
    );
    expect(text.endsWith('Reply with A, B, C, or your own words.')).toBe(true);
  });

  it('three recipients read as a list', () => {
    const { text } = composeSlackQuestion({
      card: card(),
      ...context,
      recipientNames: ['Mark', 'Ana', 'Lee'],
    });
    expect(text.split('\n')[0]).toContain('for Mark, Ana and Lee.');
  });

  it('never offers Park, and the letters follow the lane options', () => {
    const { text } = composeSlackQuestion({
      card: card({ options: [{ label: 'Yes', description: '' }, PARK], recommendation: null }),
      ...context,
    });
    expect(text).not.toContain('Park');
    expect(text).toContain('*A.* Yes\n');
    expect(text).not.toContain('*B.*');
    expect(text.endsWith('Reply with A, or your own words.')).toBe(true);
  });

  it('offers at most four options', () => {
    const options = ['a', 'b', 'c', 'd', 'e'].map((label) => ({ label, description: '' }));
    const { text } = composeSlackQuestion({
      card: card({ options, recommendation: null }),
      ...context,
    });
    expect(text).toContain('*D.* d');
    expect(text).not.toContain('*E.*');
  });

  it('marks the recommendation when it names a letter too', () => {
    const { text } = composeSlackQuestion({
      card: card({ recommendation: 'B' }),
      ...context,
    });
    expect(text).toContain('*B.* Cut access at once until payment succeeds  _(recommended)_');
    expect(text.match(/_\(recommended\)_/g)).toHaveLength(1);
  });

  it('cuts a 3,000-character body at 2,500 with (shortened)', () => {
    const { text } = composeSlackQuestion({ card: card({ body: 'x'.repeat(3000) }), ...context });
    expect(text).toContain(`${'x'.repeat(2500)} (shortened)`);
    expect(text).not.toContain('x'.repeat(2501));
  });

  it('leaves a body of exactly 2,500 characters whole', () => {
    const { text } = composeSlackQuestion({ card: card({ body: 'x'.repeat(2500) }), ...context });
    expect(text).not.toContain('(shortened)');
  });

  it('escapes the title, body, options and every name, so agent text cannot ping or link', () => {
    const { text, blocks } = composeSlackQuestion({
      card: card({
        title: '<!channel> & <@U123>',
        body: 'see <https://x|y> & `code`',
        options: [{ label: '<!here> go', description: '' }],
        recommendation: null,
      }),
      ...context,
      builderName: '<@UEVIL>',
      projectName: '<!everyone>',
      goalTitle: null,
      recipientNames: ['<@U9>'],
    });
    for (const raw of [
      '<!channel>',
      '<@U123>',
      '<https://x|y>',
      '<!here>',
      '<@UEVIL>',
      '<!everyone>',
      '<@U9>',
      '`',
    ])
      expect(text).not.toContain(raw);
    expect(text).toContain('&lt;!channel&gt; &amp; &lt;@U123&gt;');
    expect(text).toContain('see &lt;https://x|y&gt; &amp; code');
    expect(blocks.map((b) => b.text.text).join('')).not.toMatch(/<[!@h]/);
  });

  it('sends every text object verbatim as mrkdwn', () => {
    const { blocks } = composeSlackQuestion({ card: card(), ...context });
    expect(blocks.length).toBeGreaterThan(1);
    for (const block of blocks) {
      expect(block.type).toBe('section');
      expect(block.text).toMatchObject({ type: 'mrkdwn', verbatim: true });
      expect(block.text.text.length).toBeLessThanOrEqual(3000);
    }
  });
});
