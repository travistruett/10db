import type { TrustSwitches } from '@10db/contracts';
import type { SetupInput } from '../sandbox';
import { findBuilderSkills } from './builder-skills';
import {
  InstalledPluginsError,
  readInstalledPlugins,
  type InstalledPlugin,
} from './installed-plugins';
import { readInstructions, type Instructions } from './instructions';
import { leftOutFrom, type LeftOut } from './left-out';
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
    leftOut.push(
      ...leftOutFrom('yourPlugins', [{ what: "Claude Code's plugin list", why: error.message }]),
    );
    return [];
  }
  const load = installed.filter((p) => switches.plugins[p.id] ?? p.enabledInClaude);
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
  const leftOut: LeftOut[] = [
    ...leftOutFrom(
      'projectInstructions',
      instructions.leftOut.filter((item) => !item.what.startsWith('~/')),
    ),
    ...leftOutFrom(
      'yourInstructions',
      instructions.leftOut.filter((item) => item.what.startsWith('~/')),
    ),
  ];
  const builder = switches.yourSkills ? findBuilderSkills(home) : { folders: [], leftOut: [] };
  leftOut.push(...leftOutFrom('yourSkills', builder.leftOut));
  const plugins = switches.yourPlugins ? pluginsToLoad(home, switches, leftOut) : [];
  const project = switches.projectSkills
    ? readProjectDefinitions(checkout)
    : { files: [], leftOut: [] };
  leftOut.push(...leftOutFrom('projectSkills', project.leftOut));
  return {
    instructions,
    input: { skills: builder.folders, plugins, projectFiles: project.files },
    leftOut,
  };
}
