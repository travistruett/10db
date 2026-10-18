import { z } from 'zod';

/** A lowercase name of letters, digits and hyphens that starts with a letter: persona keys, flow names, skill names and handles. */
export const HyphenatedKey = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,39}$/, 'lowercase letters, digits and hyphens');
