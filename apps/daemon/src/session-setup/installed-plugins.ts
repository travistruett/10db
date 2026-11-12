import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/** A plugin Claude Code installed for the builder. */
export interface InstalledPlugin {
  /** `name@marketplace`. */
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly installPath: string;
  /** Its state in Claude Code's own `enabledPlugins`; a plugin that file doesn't name is on. */
  readonly enabledInClaude: boolean;
}

/** Claude Code's plugin list exists but is not the shape 10db reads. */
export class InstalledPluginsError extends Error {
  override readonly name = 'InstalledPluginsError';
}

const InstalledPluginsFile = z.looseObject({
  version: z.literal(2),
  plugins: z.record(
    z.string(),
    z.array(z.looseObject({ scope: z.string(), installPath: z.string(), version: z.string() })),
  ),
});

/** Only this key of the builder's settings is read; the rest of the file is never loaded. */
const EnabledPlugins = z.looseObject({
  enabledPlugins: z.record(z.string(), z.boolean()).optional(),
});

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function enabledPlugins(home: string): Record<string, boolean> {
  const text = readText(join(home, '.claude', 'settings.json'));
  if (text === null) return {};
  const parsed = EnabledPlugins.safeParse(parseJson(text));
  return parsed.success ? (parsed.data.enabledPlugins ?? {}) : {};
}

function pluginName(id: string): string {
  const at = id.lastIndexOf('@');
  return at > 0 ? id.slice(0, at) : id;
}

/**
 * The plugins Claude Code installed at user scope (`~/.claude/plugins/installed_plugins.json`), with whether
 * Claude Code has each on. No list gives none; a list that doesn't parse throws `InstalledPluginsError`.
 */
export function readInstalledPlugins(home: string): InstalledPlugin[] {
  const text = readText(join(home, '.claude', 'plugins', 'installed_plugins.json'));
  if (text === null) return [];
  const parsed = InstalledPluginsFile.safeParse(parseJson(text));
  if (!parsed.success)
    throw new InstalledPluginsError("Claude Code's plugin list is not a shape 10db reads");
  const enabled = enabledPlugins(home);
  const plugins: InstalledPlugin[] = [];
  for (const [id, installs] of Object.entries(parsed.data.plugins)) {
    const install = installs.find((i) => i.scope === 'user');
    if (!install) continue;
    plugins.push({
      id,
      name: pluginName(id),
      version: install.version,
      installPath: install.installPath,
      enabledInClaude: enabled[id] ?? true,
    });
  }
  return plugins;
}
