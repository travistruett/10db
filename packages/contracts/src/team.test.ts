import { describe, expect, it } from 'vitest';
import { mintId } from './ids';
import { PersonaInput, PersonInput, RoutingRulesInput, TeamInput } from './team';

const persona = {
  key: 'security-reviewer',
  name: 'Security reviewer',
  role: 'review',
  tools: 'read_only',
  instructions: 'Check trust boundaries.',
};

describe('team inputs', () => {
  it.each([
    {
      name: 'a persona with skills, a minimum score and a pin',
      parse: () =>
        PersonaInput.safeParse({
          ...persona,
          skills: ['review-checklist'],
          minimumScore: 52,
          modelPin: { model: 'opus', effort: 'high' },
        }),
      ok: true,
    },
    { name: 'a persona with the defaults', parse: () => PersonaInput.safeParse(persona), ok: true },
    {
      name: 'a persona key with spaces',
      parse: () => PersonaInput.safeParse({ ...persona, key: 'Security Reviewer' }),
      ok: false,
    },
    {
      name: 'a reviewer persona that can edit',
      parse: () => PersonaInput.safeParse({ ...persona, tools: 'edit' }),
      ok: false,
    },
    {
      name: 'an implementer persona that is read-only',
      parse: () => PersonaInput.safeParse({ ...persona, role: 'implement' }),
      ok: false,
    },
    {
      name: 'a minimum score above 100',
      parse: () => PersonaInput.safeParse({ ...persona, minimumScore: 101 }),
      ok: false,
    },
    {
      name: 'a skill name with a slash',
      parse: () => PersonaInput.safeParse({ ...persona, skills: ['../etc'] }),
      ok: false,
    },
    {
      name: 'a person handle with an at sign',
      parse: () => PersonInput.safeParse({ handle: '@sam', name: 'Sam' }),
      ok: false,
    },
    {
      name: 'a team binding two personas to one role',
      parse: () =>
        TeamInput.safeParse({
          bindings: [
            { role: 'review', personaId: mintId('Persona') },
            { role: 'review', personaId: mintId('Persona') },
          ],
          members: [],
        }),
      ok: false,
    },
    {
      name: 'routing rules with a duplicate category and area',
      parse: () =>
        RoutingRulesInput.safeParse({
          rules: [
            { category: 'design', area: 'ui', personId: mintId('Person') },
            { category: 'design', area: 'ui', personId: mintId('Person') },
          ],
        }),
      ok: false,
    },
    {
      name: 'routing rules for one category with and without an area',
      parse: () =>
        RoutingRulesInput.safeParse({
          rules: [
            { category: 'design', area: 'ui', personId: mintId('Person') },
            { category: 'design', area: null, personId: mintId('Person') },
          ],
        }),
      ok: true,
    },
  ])('$name', ({ parse, ok }) => {
    expect(parse().success).toBe(ok);
  });
});
