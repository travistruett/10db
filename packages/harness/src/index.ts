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
