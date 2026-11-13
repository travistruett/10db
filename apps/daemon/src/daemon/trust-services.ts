import {
  Provider,
  providerOf,
  type ProjectId,
  type ProjectTrustDto,
  type SetupPreviewDto,
  type TrustOverrides,
  type TrustSettingsDto,
  type TrustSwitches,
} from '@10db/contracts';
import { getAccountRow, getProject } from '@10db/db';
import type { ApiServices } from '../api';
import { allCheckouts } from '../delivery';
import type { StateStore } from '../events';
import {
  appTrustSwitches,
  projectTrustOverrides,
  setAppTrustSwitches,
  setProjectTrustOverrides,
  trustSwitchesFor,
  warnInvalidTrust,
} from '../permissions';
import type { LaneSandbox } from '../sandbox';
import {
  InstalledPluginsError,
  planSessionSetup,
  readInstalledPlugins,
  type InstalledPlugin,
} from '../session-setup';

export type TrustServices = Pick<
  ApiServices,
  'trustSettings' | 'setTrustSwitches' | 'projectTrust' | 'setProjectTrust'
>;

/** Claude Code's installed plugins; a list it can't read lists none here, as a session loads none. */
function installedPlugins(home: string): InstalledPlugin[] {
  try {
    return readInstalledPlugins(home);
  } catch (error) {
    if (error instanceof InstalledPluginsError) return [];
    throw error;
  }
}

/** A project skill's name, as Claude Code names it: `project:<folder>`. */
function projectSkills(files: readonly { readonly relative: string }[]): string[] {
  const names = new Set(
    files.flatMap((file) => {
      const [top, name] = file.relative.split('/');
      return top === 'skills' && name !== undefined ? [`project:${name}`] : [];
    }),
  );
  return [...names].sort();
}

/**
 * Settings › Trust (trust spec §9): the app-wide switches, each project's overrides, and what would come
 * along into a project's next session, judged as a session's setup is but writing nothing.
 */
export function createTrustServices(deps: {
  readonly state: StateStore;
  /** The builder's home, the same one sessions read their setup from. */
  readonly builderHome: string;
  /** The roots lanes write outside the registered checkouts: the worktree root and the lane temp roots. */
  readonly laneWritableRoots: readonly string[];
  /** Judges the preview's real paths; null (no sandbox) shows the plan alone. */
  readonly laneSandbox: LaneSandbox | null;
  /** Told each stored switch that reads as off for not being a shape 10db reads. */
  readonly log: { warn(fields: object, message: string): void };
}): TrustServices {
  const db = deps.state.db;
  const onInvalid = warnInvalidTrust(deps.log);

  const trustSettings = (): TrustSettingsDto => {
    const switches = appTrustSwitches(db, onInvalid);
    return {
      switches,
      plugins: installedPlugins(deps.builderHome).map((plugin) => ({
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        enabledInClaude: plugin.enabledInClaude,
        on: switches.yourPlugins && (switches.plugins[plugin.id] ?? plugin.enabledInClaude),
      })),
    };
  };

  const preview = async (
    projectId: ProjectId,
    switches: TrustSwitches,
  ): Promise<SetupPreviewDto> => {
    const project = getProject(db, projectId);
    const checkouts = allCheckouts(db);
    const plan = planSessionSetup({
      home: deps.builderHome,
      checkout: project.repoPath,
      switches,
      laneWritable: [...checkouts, ...deps.laneWritableRoots],
    });
    const judged =
      deps.laneSandbox === null
        ? {
            loaded: {
              skills: plan.input.skills.map((skill) => skill.name),
              plugins: plan.input.plugins.map((plugin) => plugin.id),
            },
            leftOut: [],
          }
        : await deps.laneSandbox.judgeSetup(project, plan.input, checkouts);
    // Codex takes a plugin's skills and nothing else of it: the preview says what the session gets.
    const codex = providerOf(getAccountRow(db, project.accountId).kind) === Provider.Codex;
    return {
      skills: [...judged.loaded.skills, ...projectSkills(plan.input.projectFiles)],
      plugins: judged.loaded.plugins.map((id) => (codex ? `${id} (its skills only)` : id)),
      leftOut: [...plan.leftOut, ...judged.leftOut],
    };
  };

  const projectTrust = async (projectId: ProjectId): Promise<ProjectTrustDto> => {
    getProject(db, projectId);
    const effective = trustSwitchesFor(db, projectId, onInvalid);
    return {
      overrides: projectTrustOverrides(db, projectId, onInvalid),
      effective,
      preview: await preview(projectId, effective),
    };
  };

  return {
    trustSettings,
    setTrustSwitches(switches) {
      deps.state.write((ctx) => {
        setAppTrustSwitches(ctx, switches);
      });
      return trustSettings();
    },
    projectTrust,
    async setProjectTrust(projectId, overrides: TrustOverrides) {
      getProject(db, projectId);
      deps.state.write((ctx) => {
        setProjectTrustOverrides(ctx, projectId, overrides);
      });
      return projectTrust(projectId);
    },
  };
}
