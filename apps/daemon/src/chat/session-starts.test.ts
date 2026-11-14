import { describe, expect, it } from 'vitest';
import { sessionStarts, type StartFacts } from './session-starts';

// UI spec §6.2: at most three Start from prompts, each from one fact, in one order.

const ALL: StartFacts = {
  failedTask: { title: 'Retry login once on a 401' },
  baseCommits: { base: 'main', count: 3 },
  recentArea: 'billing',
};

describe('sessionStarts', () => {
  it.each<{ name: string; facts: StartFacts; texts: string[] }>([
    {
      name: 'every fact gives three, in order',
      facts: ALL,
      texts: [
        'Why did “Retry login once on a 401” fail?',
        'What changed on main since yesterday?',
        'How does billing work?',
      ],
    },
    {
      name: 'no fact gives none',
      facts: { failedTask: null, baseCommits: null, recentArea: null },
      texts: [],
    },
    {
      name: 'no commits drops the second',
      facts: { ...ALL, baseCommits: { base: 'main', count: 0 } },
      texts: ['Why did “Retry login once on a 401” fail?', 'How does billing work?'],
    },
    {
      name: 'a long title is cut at 60 with an ellipsis',
      facts: { failedTask: { title: 'x'.repeat(80) }, baseCommits: null, recentArea: null },
      texts: [`Why did “${'x'.repeat(59)}…” fail?`],
    },
  ])('$name', ({ facts, texts }) => {
    expect(sessionStarts(facts).map((s) => s.text)).toEqual(texts);
  });

  it('names each source by its kind', () => {
    expect(sessionStarts(ALL).map((s) => s.kind)).toEqual([
      'failed_task',
      'base_commits',
      'recent_area',
    ]);
  });
});
