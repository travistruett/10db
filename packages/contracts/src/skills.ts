import { z } from 'zod';

/** The craft skills the harness plugin ships; a kind names them to load them in every step of its tasks. */
export const SKILL_NAMES = [
  'planning',
  'test-first',
  'review-checklist',
  'brainstorming',
  'handoff',
] as const;

export const SkillName = z.enum(SKILL_NAMES);
export type SkillName = z.infer<typeof SkillName>;
