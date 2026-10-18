import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';

/** The plugin directory injected into managed sessions. */
export const HARNESS_PLUGIN_DIR = resolve(import.meta.dirname, '../plugin');

export const PluginManifest = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
});
export type PluginManifest = z.infer<typeof PluginManifest>;

export function readPluginManifest(dir: string = HARNESS_PLUGIN_DIR): PluginManifest {
  const text = readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8');
  return PluginManifest.parse(JSON.parse(text));
}

/** The craft skills every managed session loads (spec §11.3). */
export const SKILL_NAMES = [
  'planning',
  'test-first',
  'review-checklist',
  'brainstorming',
  'handoff',
] as const;

/** Skills load into every session's context, so each one stays small. */
export const MAX_SKILL_BYTES = 2048;

export interface SkillInfo {
  readonly name: string;
  readonly description: string;
  readonly bytes: number;
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;

/** Plain single-line scalars only: a quote or block indicator would be kept literally. */
const PlainValue = z
  .string()
  .min(1)
  .refine((value) => !/^[>|"']/.test(value), 'must be a plain single-line value');

const SkillFrontmatter = z.object({ name: PlainValue, description: PlainValue });

/** A skill's SKILL.md is missing, unreadable or has invalid frontmatter. */
export class SkillManifestError extends Error {
  override name = 'SkillManifestError';

  constructor(path: string, reason: string, options?: ErrorOptions) {
    super(`${path}: ${reason}`, options);
  }
}

function frontmatterFields(block: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) fields[match[1]] = match[2].trim();
  }
  return fields;
}

function readSkill(root: string, directory: string): SkillInfo {
  const path = join(root, directory, 'SKILL.md');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new SkillManifestError(path, 'SKILL.md cannot be read', { cause: error });
  }
  const block = FRONTMATTER.exec(text)?.[1];
  if (block === undefined) throw new SkillManifestError(path, 'frontmatter is missing');
  const parsed = SkillFrontmatter.safeParse(frontmatterFields(block));
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new SkillManifestError(
      path,
      `frontmatter needs a plain name and description (${fields})`,
    );
  }
  if (parsed.data.name !== directory) {
    throw new SkillManifestError(
      path,
      `name "${parsed.data.name}" must match its directory "${directory}"`,
    );
  }
  return {
    name: parsed.data.name,
    description: parsed.data.description,
    bytes: Buffer.byteLength(text, 'utf8'),
  };
}

export function listSkills(dir: string = HARNESS_PLUGIN_DIR): SkillInfo[] {
  const root = join(dir, 'skills');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readSkill(root, entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The default personas 10db seeds when it starts (spec §11.3), one per flow role. */
export const PERSONA_KEYS = ['implementer', 'plan-reviewer', 'planner', 'qa', 'reviewer'] as const;

/** A persona's instructions ride in every session prompt for its step, so they stay short. */
export const MAX_PERSONA_BYTES = 4096;

const PERSONA_KEY = /^[a-z][a-z0-9-]{0,39}$/;

const PersonaFrontmatter = z
  .object({
    name: PlainValue,
    role: z.enum(['plan', 'plan_review', 'implement', 'review', 'qa']),
    tools: z.enum(['read_only', 'edit']),
    skills: z
      .string()
      .optional()
      .transform((list) =>
        list
          ? list
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : [],
      )
      .pipe(z.array(z.enum(SKILL_NAMES))),
  })
  .refine((p) => (p.role === 'implement') === (p.tools === 'edit'), {
    message: 'only the implement role edits',
  });

export interface HarnessPersona {
  readonly key: string;
  readonly name: string;
  readonly role: z.infer<typeof PersonaFrontmatter>['role'];
  readonly tools: z.infer<typeof PersonaFrontmatter>['tools'];
  readonly skills: readonly string[];
  readonly instructions: string;
}

/** A persona file is unreadable, misnamed or has invalid frontmatter or instructions. */
export class PersonaManifestError extends Error {
  override name = 'PersonaManifestError';

  constructor(path: string, reason: string, options?: ErrorOptions) {
    super(`${path}: ${reason}`, options);
  }
}

function readPersona(root: string, file: string): HarnessPersona {
  const path = join(root, file);
  const key = file.slice(0, -'.md'.length);
  if (!PERSONA_KEY.test(key))
    throw new PersonaManifestError(path, 'the file name must be a lowercase key');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new PersonaManifestError(path, 'cannot be read', { cause: error });
  }
  const match = FRONTMATTER.exec(text);
  if (!match?.[1]) throw new PersonaManifestError(path, 'frontmatter is missing');
  const parsed = PersonaFrontmatter.safeParse(frontmatterFields(match[1]));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => i.message).join(', ');
    throw new PersonaManifestError(
      path,
      `frontmatter needs a name, a role, tools and known skills (${issues})`,
    );
  }
  const instructions = text.slice(match[0].length).trim();
  if (instructions.length === 0) throw new PersonaManifestError(path, 'the instructions are empty');
  if (Buffer.byteLength(instructions, 'utf8') >= MAX_PERSONA_BYTES)
    throw new PersonaManifestError(
      path,
      `the instructions must be under ${String(MAX_PERSONA_BYTES)} bytes`,
    );
  return { key, ...parsed.data, instructions };
}

export function readDefaultPersonas(dir: string = HARNESS_PLUGIN_DIR): HarnessPersona[] {
  const root = join(dir, 'personas');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => readPersona(root, entry.name))
    .sort((a, b) => a.key.localeCompare(b.key));
}
