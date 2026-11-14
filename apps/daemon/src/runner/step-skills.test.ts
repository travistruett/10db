import type { SkillName } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { stepSkills } from './step-skills';

describe('stepSkills', () => {
  it.each<{
    name: string;
    persona: readonly SkillName[] | null;
    kinds: readonly (readonly SkillName[])[];
    skills: readonly SkillName[];
  }>([
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
    { name: 'a kind with none', persona: ['planning'], kinds: [[]], skills: ['planning'] },
  ])('$name', ({ persona, kinds, skills }) => {
    expect(
      stepSkills(
        persona === null ? null : { skills: persona },
        kinds.map((k) => ({ skills: k })),
      ),
    ).toEqual(skills);
  });
});
