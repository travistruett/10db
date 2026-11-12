import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { foldPathCase } from '../guard';
import { linkWithRewrites, type Rewrite } from './setup-definitions';

interface LeftOut {
  readonly what: string;
  readonly why: string;
}

/**
 * The only top-level entries a wrapper links, by their folded names. A list of what to leave out would
 * miss `Hooks/` or `.MCP.json`, which APFS opens for `hooks/` and `.mcp.json`; an MCP or LSP server, a
 * hook or a `settings.json` never comes along.
 */
const CARRIED = ['skills', 'agents', 'commands'] as const;

/** Manifest keys that move a part of the plugin; the wrapper lays out only the default folders. */
const LAYOUT_KEYS = ['commands', 'agents', 'skills'] as const;

/**
 * A plugin hook runs in Claude Code's process, outside the sandbox, and its answer can run a call 10db's
 * guard never judged (a rewritten input) or skip 10db's broker (an allow): research L3b.
 */
const HOOKS_LEFT_OUT = "plugin hooks don't run in 10db sessions yet";

const Manifest = z.looseObject({
  version: z.string().optional(),
  description: z.string().optional(),
});

/** The plugin's folders the wrapper carries, each as written beside the name it takes in the wrapper. */
export function carriedEntries(
  installPath: string,
): (readonly [string, (typeof CARRIED)[number]])[] {
  const carried: (readonly [string, (typeof CARRIED)[number]])[] = [];
  for (const entry of readdirSync(installPath).sort()) {
    // Folded as the file system folds names: `Skills` is `skills`, under the wrapper's own spelling.
    const name = CARRIED.find((kind) => kind === foldPathCase(entry));
    if (name === undefined || carried.some(([, taken]) => taken === name)) continue;
    carried.push([entry, name]);
  }
  return carried;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Writes a wrapper for one installed plugin at `into`: the plugin's name, version and description, and a
 * link to its skills, agents and commands, and nothing else: never its MCP or LSP servers or its hooks.
 * A folder holding one of `rewrites` (relative to the install path) is laid out as links with that file
 * re-emitted or left out (`pluginChanges`).
 */
export function wrapPlugin(
  installPath: string,
  into: string,
  rewrites: readonly Rewrite[],
): { leftOut: LeftOut[] } {
  const leftOut: LeftOut[] = [];
  const raw = readJson(join(installPath, '.claude-plugin', 'plugin.json'));
  const parsed = Manifest.safeParse(raw ?? {});
  const manifest = parsed.success ? parsed.data : {};
  // The wrapper's folder is the plugin id's name; a manifest naming another (`yours`) never takes it.
  const name = basename(into);
  const moved = LAYOUT_KEYS.filter((key) => key in manifest);
  if (moved.length > 0)
    leftOut.push({
      what: `${name}: ${moved.join(', ')} in its manifest`,
      why: 'the wrapper lays out only the default folders',
    });
  if ('hooks' in manifest || existsSync(join(installPath, 'hooks')))
    leftOut.push({ what: `${name}'s hooks`, why: HOOKS_LEFT_OUT });
  mkdirSync(join(into, '.claude-plugin'), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(into, '.claude-plugin', 'plugin.json'),
    JSON.stringify({
      name,
      ...(manifest.version === undefined ? {} : { version: manifest.version }),
      ...(manifest.description === undefined ? {} : { description: manifest.description }),
    }),
    { mode: 0o600 },
  );
  for (const [entry, name] of carriedEntries(installPath))
    linkWithRewrites(join(installPath, entry), join(into, name), entry, rewrites);
  return { leftOut };
}
