import type { TrustSwitches } from '@10db/contracts';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { SetupInput } from '../sandbox';
import { findBuilderSkills } from './builder-skills';
import {
  InstalledPluginsError,
  readInstalledPlugins,
  type InstalledPlugin,
} from './installed-plugins';
import { readInstructions, type Instructions } from './instructions';
import type { LeftOut } from './left-out';
import { readProjectDefinitions } from './project-definitions';

/** What one session starts with, before the lane sandbox judges the real paths. */
export interface SessionSetupPlan {
  readonly instructions: Instructions;
  readonly input: SetupInput;
  /** Everything left out so far, the instructions' included. */
  readonly leftOut: readonly LeftOut[];
}

interface PlanArgs {
  readonly home: string;
  readonly checkout: string;
  readonly switches: TrustSwitches;
  /** Every root a lane can write. */
  readonly laneWritable: readonly string[];
}

const PluginManifest = z.looseObject({ mcpServers: z.unknown().optional() });

/** A plugin declares MCP servers with a `.mcp.json` beside its manifest or `mcpServers` in it. */
function declaresMcpServers(installPath: string): boolean {
  if (existsSync(join(installPath, '.mcp.json'))) return true;
  let text: string;
  try {
    text = readFileSync(join(installPath, '.claude-plugin', 'plugin.json'), 'utf8');
  } catch {
    return false;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return false;
  }
  const manifest = PluginManifest.safeParse(json);
  return manifest.success && manifest.data.mcpServers !== undefined;
}

function pluginsToLoad(
  home: string,
  switches: TrustSwitches,
  leftOut: LeftOut[],
): { id: string; path: string }[] {
  let installed: InstalledPlugin[];
  try {
    installed = readInstalledPlugins(home);
  } catch (error) {
    if (!(error instanceof InstalledPluginsError)) throw error;
    leftOut.push({ what: "Claude Code's plugin list", why: error.message });
    return [];
  }
  const load = installed.filter((p) => switches.plugins[p.id] ?? p.enabledInClaude);
  for (const p of load) {
    if (declaresMcpServers(p.installPath))
      leftOut.push({ what: `${p.id}'s MCP servers`, why: 'until 10db runs your MCP servers (T6)' });
  }
  return load.map((p) => ({ id: p.id, path: p.installPath }));
}

/** What the trust switches bring into one session from the builder's home and the project's checkout. */
export function planSessionSetup(args: PlanArgs): SessionSetupPlan {
  const { home, checkout, switches } = args;
  const instructions = readInstructions({
    checkout,
    home,
    project: switches.projectInstructions,
    yours: switches.yourInstructions,
    laneWritable: args.laneWritable,
  });
  const leftOut: LeftOut[] = [...instructions.leftOut];
  const builder = switches.yourSkills ? findBuilderSkills(home) : { folders: [], leftOut: [] };
  leftOut.push(...builder.leftOut);
  const plugins = switches.yourPlugins ? pluginsToLoad(home, switches, leftOut) : [];
  const project = switches.projectSkills
    ? readProjectDefinitions(checkout)
    : { files: [], leftOut: [] };
  leftOut.push(...project.leftOut);
  return {
    instructions,
    input: { skills: builder.folders, plugins, projectFiles: project.files },
    leftOut,
  };
}
