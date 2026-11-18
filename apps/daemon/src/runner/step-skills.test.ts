import type { SkillName } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { stepSkills } from './step-skills';

describe('stepSkills', () => {
  it("names the persona's shipped skills, then each kind's, once each, and planning last when a build step plans first", () => {
    const rows: {
      name: string;
      persona: readonly string[] | null;
      kinds: readonly (readonly SkillName[])[];
      plansFirst?: boolean;
      skills: readonly SkillName[];
    }[] = [
      { name: 'no persona and no kinds', persona: null, kinds: [], skills: [] },
      {
        name: 'the persona alone',
        persona: ['test-first', 'handoff'],
        kinds: [],
        skills: ['test-first', 'handoff'],
      },
      {
        name: 'a kind adds after the persona',
        persona: ['test-first'],
        kinds: [['brainstorming']],
        skills: ['test-first', 'brainstorming'],
      },
      {
        name: 'a skill the persona and a kind share is named once, in the persona place',
        persona: ['test-first', 'handoff'],
        kinds: [['handoff', 'planning']],
        skills: ['test-first', 'handoff', 'planning'],
      },
      {
        name: 'two kinds in order, deduplicated',
        persona: null,
        kinds: [
          ['planning', 'handoff'],
          ['handoff', 'brainstorming'],
        ],
        skills: ['planning', 'handoff', 'brainstorming'],
      },
      {
        name: 'a persona skill the harness does not ship is dropped',
        persona: ['test-first', 'nonsense'],
        kinds: [],
        skills: ['test-first'],
      },
      { name: 'a kind with none', persona: ['planning'], kinds: [[]], skills: ['planning'] },
      {
        name: 'a build step that plans first adds planning last',
        persona: ['test-first', 'handoff'],
        kinds: [['brainstorming']],
        plansFirst: true,
        skills: ['test-first', 'handoff', 'brainstorming', 'planning'],
      },
      {
        name: 'a build step that plans first names planning once',
        persona: ['planning', 'test-first'],
        kinds: [],
        plansFirst: true,
        skills: ['planning', 'test-first'],
      },
    ];
    for (const { name, persona, kinds, plansFirst, skills } of rows) {
      expect
        .soft(
          stepSkills(
            persona === null ? null : { skills: persona },
            kinds.map((k) => ({ skills: k })),
            { plansFirst: plansFirst === true },
          ),
          name,
        )
        .toEqual(skills);
    }
  });
});
