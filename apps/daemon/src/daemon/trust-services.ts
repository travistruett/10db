import {
  ConflictError,
  InvalidError,
  JudgeDecision,
  NotFoundError,
  YourMcpServerState,
  YourMcpSource,
  Provider,
  requireHarness,
  type LiveSystemsDto,
  type ProjectId,
  type ProjectTrustDto,
  type SetupPreviewDto,
  type TrustOverrides,
  type TrustSettingsDto,
  type TrustSwitches,
} from '@10db/contracts';
import {
  deleteTrustGrant,
  getAccountRow,
  getProject,
  listProjects,
  listTrustGrants,
} from '@10db/db';
import type { ApiServices } from '../api';
import { allCheckouts } from '../delivery';
import type { StateStore } from '../events';
import type { Judge } from '../judge';
import {
  approveMcpServer,
  appTrustSwitches,
  mcpApprovals,
  projectTrustOverrides,
  setAppTrustSwitches,
  setProjectTrustOverrides,
  trustSwitchesFor,
  warnInvalidTrust,
} from '../permissions';
import { laneWritableRoots, SYSTEM_TEMP_ROOTS, type LaneSandbox } from '../sandbox';
import type { AgentAdapter } from '../sessions';
import {
  InstalledPluginsError,
  planSessionSetup,
  planYourMcp,
  readInstalledPlugins,
  readYourMcpConfig,
  yourMcpServerDtos,
  type InstalledPlugin,
  type YourMcpPlan,
} from '../session-setup';
import { projectLiveSystems, setProjectLiveSystems } from '../trust';
import { accountJudges } from './account-judges';
import type { ProjectMcpServers } from './connect-service';

export type TrustServices = Pick<
  ApiServices,
  | 'trustSettings'
  | 'setTrustSwitches'
  | 'approveYourMcpServer'
  | 'projectTrust'
  | 'setProjectTrust'
  | 'liveSystems'
  | 'setLiveSystems'
  | 'trustGrants'
  | 'removeTrustGrant'
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
  /** The folder worktrees are made in, whole: a lane can write anywhere in it. */
  readonly worktreeBase: string;
  /** The login shell's own `CLAUDE_CONFIG_DIR` and `CODEX_HOME`, which 10db's servers list doesn't follow. */
  readonly login: {
    readonly configDir: () => string | null;
    readonly codexHome: () => string | null;
  };
  /** Judges the preview's real paths; null (no sandbox) shows the plan alone. */
  readonly laneSandbox: LaneSandbox | null;
  /** Says what judges each account's calls. */
  readonly adapter: Pick<AgentAdapter, 'capabilities'>;
  /** Says whether 10db's judge can answer, for the accounts it judges. */
  readonly judge: Pick<Judge, 'ready'>;
  /** Told each stored switch that reads as off for not being a shape 10db reads. */
  readonly log: { warn(fields: object, message: string): void };
  /** The login environment without billing switches, as sessions expand `${VAR}` in a server's entry from it. */
  readonly loginEnv: () => Readonly<Record<string, string>>;
}): TrustServices & {
  /** The builder's servers as a session on the app-wide switches would plan them. */
  readonly appMcpPlan: () => YourMcpPlan;
  /** The builder's servers as a project's sessions would see them, on its effective switches, read now. */
  readonly projectMcpServers: (projectId: ProjectId) => ProjectMcpServers;
} {
  const db = deps.state.db;
  const onInvalid = warnInvalidTrust(deps.log);

  /** Every root a lane can write, as the launch judges it: the readers of the builder's config use the same list. */
  const writableRoots = () =>
    laneWritableRoots({
      checkouts: allCheckouts(db),
      worktreeBase: deps.worktreeBase,
      sandboxTempRoots: deps.laneWritableRoots,
      systemTempRoots: SYSTEM_TEMP_ROOTS,
    });

  /** The builder's servers, read now: from their files and the plugins a session would load. */
  const yourServers = (switches: TrustSwitches) => {
    const roots = writableRoots();
    const plugins = switches.yourPlugins
      ? installedPlugins(deps.builderHome).filter(
          (plugin) => switches.plugins[plugin.id] ?? plugin.enabledInClaude,
        )
      : [];
    const { entries, fileProblems } = readYourMcpConfig({
      home: deps.builderHome,
      laneWritable: roots.map((root) => root.path),
      plugins,
    });
    const approvals = mcpApprovals(db, () => {
      deps.log.warn({}, 'the stored MCP approvals are not a shape 10db reads, so none holds');
    });
    const servers = yourMcpServerDtos({
      entries,
      switches,
      approvals,
      home: deps.builderHome,
      laneWritable: roots,
    });
    return { servers, fileProblems, entries, approvals };
  };

  const projectMcpServers = (projectId: ProjectId): ProjectMcpServers => {
    const switches = trustSwitchesFor(db, projectId, onInvalid);
    const { servers, entries, approvals } = yourServers(switches);
    const plan = planYourMcp({
      entries,
      switches,
      approvals,
      projectServerNames: [],
      loginEnv: deps.loginEnv(),
      localBinding: getProject(db, projectId).sandboxLoopback,
    });
    return {
      servers,
      on: switches.yourMcpServers,
      loaded: Object.fromEntries(
        Object.entries(plan.remote).map(([name, remote]) => [name, remote.key]),
      ),
    };
  };

  const appMcpPlan = (): YourMcpPlan => {
    const switches = appTrustSwitches(db, onInvalid);
    const { entries, approvals } = yourServers(switches);
    return planYourMcp({
      entries,
      switches,
      approvals,
      projectServerNames: [],
      loginEnv: deps.loginEnv(),
      localBinding: listProjects(db).some((project) => project.sandboxLoopback),
    });
  };

  /** Said above the servers when the builder's shell points Claude Code or Codex somewhere else. */
  const mcpNotice = (): string | null => {
    const lines = [
      ...(deps.login.configDir() === null
        ? []
        : [
            'Your shell sets CLAUDE_CONFIG_DIR. 10db reads your servers from ~/.claude.json, not from there.',
          ]),
      ...(deps.login.codexHome() === null
        ? []
        : [
            'Your shell sets CODEX_HOME. 10db reads your servers from ~/.codex/config.toml, not from there.',
          ]),
    ];
    return lines.length === 0 ? null : lines.join(' ');
  };

  const trustSettings = async (): Promise<TrustSettingsDto> => {
    const switches = appTrustSwitches(db, onInvalid);
    const tendbReady = await deps.judge.ready(JudgeDecision.CrossesLimit);
    const { servers, fileProblems } = yourServers(switches);
    const notice = [
      mcpNotice(),
      ...fileProblems.map((problem) => `${problem.what}: ${problem.why}`),
    ]
      .filter((line) => line !== null)
      .join(' ');
    return {
      tendbReady,
      switches,
      plugins: installedPlugins(deps.builderHome).map((plugin) => ({
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        enabledInClaude: plugin.enabledInClaude,
        on: switches.yourPlugins && (switches.plugins[plugin.id] ?? plugin.enabledInClaude),
      })),
      judges: accountJudges(db, deps.adapter),
      mcpServers: servers,
      mcpNotice: notice === '' ? null : notice,
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
      laneWritable: writableRoots().map((root) => root.path),
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
    const codex = requireHarness(getAccountRow(db, project.accountId)) === Provider.Codex;
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

  const liveSystems = (projectId: ProjectId): LiveSystemsDto => {
    getProject(db, projectId);
    return {
      liveSystems: projectLiveSystems(db, projectId, (stored) => {
        deps.log.warn(
          { projectId, stored },
          'the stored live systems are not a list 10db reads, so it reads none',
        );
      }),
    };
  };

  return {
    appMcpPlan,
    projectMcpServers,
    trustSettings,
    async setTrustSwitches(switches) {
      deps.state.write((ctx) => {
        setAppTrustSwitches(ctx, switches);
      });
      return trustSettings();
    },
    async approveYourMcpServer(input) {
      const switches = appTrustSwitches(db, onInvalid);
      const server = yourServers(switches).servers.find((s) => s.key === input.key);
      // The page showed a config that is gone or changed since: nothing is stored.
      if (server?.configHash !== input.configHash)
        throw new ConflictError('This server changed since the page loaded. Review it again.');
      if (server.source === YourMcpSource.Plugin)
        throw new InvalidError("A plugin's servers come with the plugin.");
      if (server.state === YourMcpServerState.LeftOut)
        throw new ConflictError(server.reason ?? "10db can't run this server.");
      deps.state.write((ctx) => {
        approveMcpServer(ctx, input.key, input.configHash);
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
    liveSystems,
    setLiveSystems(projectId, input) {
      getProject(db, projectId);
      deps.state.write((ctx) => {
        setProjectLiveSystems(ctx, projectId, input.liveSystems);
      });
      return liveSystems(projectId);
    },
    trustGrants(projectId) {
      getProject(db, projectId);
      return listTrustGrants(db, projectId);
    },
    removeTrustGrant(projectId, grantId) {
      getProject(db, projectId);
      const removed = deps.state.write((ctx) => deleteTrustGrant(ctx, projectId, grantId));
      if (!removed) throw new NotFoundError('grant', grantId);
    },
  };
}
