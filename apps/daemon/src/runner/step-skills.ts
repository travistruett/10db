import { SkillName } from '@10db/contracts';

/**
 * The craft skills one step loads: its persona's, then each of the task's kinds', each named once, in
 * that order. A persona-less step takes only the kinds'. A persona is stored with names as text, so a
 * name the harness does not ship is dropped. A build step that plans first loads the planning skill too.
 */
export function stepSkills(
  persona: { readonly skills: readonly string[] } | null,
  kinds: readonly { readonly skills: readonly SkillName[] }[],
  step: { readonly plansFirst: boolean },
): SkillName[] {
  const fromPersona = (persona?.skills ?? []).flatMap((name) => {
    const known = SkillName.safeParse(name);
    return known.success ? [known.data] : [];
  });
  return [
    ...new Set([
      ...fromPersona,
      ...kinds.flatMap((kind) => kind.skills),
      ...(step.plansFirst ? [SkillName.enum.planning] : []),
    ]),
  ];
}
