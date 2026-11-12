import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { foldPathCase } from '../guard';

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
  name: z.string().min(1).optional(),
  version: z.string().optional(),
  description: z.string().optional(),
});

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
 */
export function wrapPlugin(installPath: string, into: string): { leftOut: LeftOut[] } {
  const leftOut: LeftOut[] = [];
  const raw = readJson(join(installPath, '.claude-plugin', 'plugin.json'));
  const parsed = Manifest.safeParse(raw ?? {});
  const manifest = parsed.success ? parsed.data : {};
  const name = manifest.name ?? basename(into);
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
  const linked = new Set<string>();
  for (const entry of readdirSync(installPath)) {
    // Folded as the file system folds names: `Skills` is `skills`, under the wrapper's own spelling.
    const name = CARRIED.find((carried) => carried === foldPathCase(entry));
    if (name === undefined || linked.has(name)) continue;
    linked.add(name);
    symlinkSync(join(installPath, entry), join(into, name));
  }
  return { leftOut };
}
