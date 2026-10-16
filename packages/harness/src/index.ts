import { readFileSync } from 'node:fs';
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
