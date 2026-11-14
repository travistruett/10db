import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { foldPathCase } from '../guard';
import { singleQuoted } from './posix-quote';
import { linkWithRewrites, type Rewrite } from './setup-definitions';

interface LeftOut {
  readonly what: string;
  readonly why: string;
}

/**
 * The only top-level entries a wrapper links, by their folded names. A list of what to leave out would
 * miss `.MCP.json`, which APFS opens for `.mcp.json`; an MCP or LSP server or a `settings.json` never
 * comes along. `hooks/` comes along re-emitted (`wrapHooks`).
 */
const CARRIED = ['skills', 'agents', 'commands'] as const;

/** Manifest keys that move a part of the plugin; the wrapper lays out only the default folders. */
const LAYOUT_KEYS = ['hooks', 'commands', 'agents', 'skills'] as const;

const Hook = z.looseObject({ type: z.string(), command: z.string().optional() });
const HooksFile = z.looseObject({
  hooks: z.record(
    z.string(),
    z.array(z.looseObject({ matcher: z.string().optional(), hooks: z.array(Hook) })),
  ),
});

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

/** The entry of `dir` the file system opens for `name`, as it folds names; null when there is none. */
function entryNamed(dir: string, name: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return null;
  }
  return entries.find((entry) => foldPathCase(entry) === foldPathCase(name)) ?? null;
}

/**
 * The plugin's hooks, as Claude Code runs them (the builder installed them), with each command hook
 * started in the wrapper's own folder. A hook runs in Claude Code's process, outside the sandbox, with
 * the checkout as its working directory; started here instead, a program it resolves from its working
 * directory (`npx`, `node`, a bin) is the plugin's, never a lane's. The hooks folder's other entries
 * (the scripts the hooks run) are linked.
 */
function wrapHooks(installPath: string, into: string, name: string, leftOut: LeftOut[]): void {
  const folder = entryNamed(installPath, 'hooks');
  if (folder === null) return;
  const hooksDir = join(installPath, folder);
  let entries: string[];
  try {
    entries = readdirSync(hooksDir);
  } catch {
    return;
  }
  const file = entries.find((entry) => foldPathCase(entry) === foldPathCase('hooks.json'));
  mkdirSync(join(into, 'hooks'), { mode: 0o700 });
  for (const entry of entries)
    if (entry !== file) symlinkSync(join(hooksDir, entry), join(into, 'hooks', entry));
  if (file === undefined) return;
  const hooks = HooksFile.safeParse(readJson(join(hooksDir, file)));
  if (!hooks.success) {
    leftOut.push({ what: `${name}'s hooks`, why: 'its hooks.json is not a shape 10db reads' });
    return;
  }
  const start = `cd ${singleQuoted(into)} && `;
  const emitted = {
    ...hooks.data,
    hooks: Object.fromEntries(
      Object.entries(hooks.data.hooks).map(([event, groups]) => [
        event,
        groups.map((group) => ({
          ...group,
          hooks: group.hooks.map((hook) =>
            hook.type === 'command' && hook.command !== undefined
              ? { ...hook, command: `${start}${hook.command}` }
              : hook,
          ),
        })),
      ]),
    ),
  };
  writeFileSync(join(into, 'hooks', 'hooks.json'), JSON.stringify(emitted, null, 2), {
    mode: 0o600,
  });
}

/**
 * Writes a wrapper for one installed plugin at `into`: the plugin's name, version and description, a
 * link to its skills, agents and commands, and its hooks re-emitted (`wrapHooks`): never its MCP or LSP
 * servers or its `settings.json`.
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
  wrapHooks(installPath, into, name, leftOut);
  return { leftOut };
}
