import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { singleQuoted } from './posix-quote';

interface LeftOut {
  readonly what: string;
  readonly why: string;
}

/**
 * Top-level entries a wrapper never links. The manifest and `hooks/` are re-emitted; `.mcp.json` and
 * `.lsp.json` start servers in Claude Code's process, outside the sandbox; a plugin's `settings.json` can
 * change the session's main agent.
 */
const NOT_LINKED: ReadonlySet<string> = new Set([
  '.claude-plugin',
  '.mcp.json',
  '.lsp.json',
  'settings.json',
  'hooks',
]);

/** Manifest keys that move a part of the plugin; the wrapper lays out only the default folders. */
const LAYOUT_KEYS = ['hooks', 'commands', 'agents', 'skills'] as const;

const Manifest = z.looseObject({
  name: z.string().min(1).optional(),
  version: z.string().optional(),
  description: z.string().optional(),
});

const Hook = z.looseObject({ type: z.string(), command: z.string().optional() });
const HooksFile = z.looseObject({
  hooks: z.record(
    z.string(),
    z.array(z.looseObject({ matcher: z.string().optional(), hooks: z.array(Hook) })),
  ),
});

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Writes a wrapper for one installed plugin at `into`: the plugin's name, version and description, a link to
 * every part of it but its MCP and LSP servers, and its `hooks.json` with each command hook started in the
 * wrapper's own folder. A plugin hook runs in Claude Code's process, outside the sandbox, with the checkout
 * as its working directory; started here instead, a program it resolves from its working directory (`npx`,
 * `node`, a bin) is the plugin's, never a lane's.
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
  for (const entry of readdirSync(installPath)) {
    if (NOT_LINKED.has(entry)) continue;
    symlinkSync(join(installPath, entry), join(into, entry));
  }
  const hooksDir = join(installPath, 'hooks');
  let hookEntries: string[];
  try {
    hookEntries = readdirSync(hooksDir);
  } catch {
    return { leftOut };
  }
  mkdirSync(join(into, 'hooks'), { mode: 0o700 });
  for (const entry of hookEntries) {
    if (entry === 'hooks.json') continue;
    symlinkSync(join(hooksDir, entry), join(into, 'hooks', entry));
  }
  if (!hookEntries.includes('hooks.json')) return { leftOut };
  const hooks = HooksFile.safeParse(readJson(join(hooksDir, 'hooks.json')));
  if (!hooks.success) {
    leftOut.push({ what: `${name}'s hooks`, why: 'its hooks.json is not a shape 10db reads' });
    return { leftOut };
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
  return { leftOut };
}
