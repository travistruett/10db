import { describe, expect, it } from 'vitest';
import { mintId } from './ids';
import { PersonaInput, PersonInput, RoutingRulesInput } from './team';

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
      name: 'a persona with skills',
      parse: () =>
        PersonaInput.safeParse({
          ...persona,
          skills: ['review-checklist'],
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
      name: 'routing rules with a duplicate category, area and person',
      parse: () => {
        const personId = mintId('Person');
        return RoutingRulesInput.safeParse({
          rules: [
            { category: 'design', area: 'ui', personId },
            { category: 'design', area: 'ui', personId },
          ],
        });
      },
      ok: false,
    },
    {
      name: 'routing rules for one category and area for two people (a tie)',
      parse: () =>
        RoutingRulesInput.safeParse({
          rules: [
            { category: 'design', area: 'ui', personId: mintId('Person') },
            { category: 'design', area: 'ui', personId: mintId('Person') },
          ],
        }),
      ok: true,
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
