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

function frontmatterField(block: string, field: string): string | undefined {
  const line = block.split('\n').find((l) => l.startsWith(`${field}:`));
  return line?.slice(field.length + 1).trim();
}

export function listSkills(dir: string = HARNESS_PLUGIN_DIR): SkillInfo[] {
  const root = join(dir, 'skills');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const path = join(root, entry.name, 'SKILL.md');
      const text = readFileSync(path, 'utf8');
      const block = FRONTMATTER.exec(text)?.[1];
      const name = block ? frontmatterField(block, 'name') : undefined;
      const description = block ? frontmatterField(block, 'description') : undefined;
      if (!name || !description)
        throw new Error(`${path} needs frontmatter with name and description`);
      return { name, description, bytes: Buffer.byteLength(text, 'utf8') };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
