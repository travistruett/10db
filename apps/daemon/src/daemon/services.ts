import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACTIVE_STATES,
  Delivery,
  InvalidError,
  type McpServerStatusDto,
  ProjectInput,
  type ProjectDto,
  WorkstreamState,
  type SystemCheckDto,
  type TaskLanding,
} from '@10db/contracts';
import {
  cancelTask,
  closeTask,
  reopenTask,
  deleteBoardColumn,
  getMcpApproval,
  getProject,
  getTask,
  getTeam,
  getWorkstream,
  holdTask,
  insertBoardColumn,
  insertFlow,
  insertPerson,
  insertPersona,
  insertProject,
  insertTask,
  latestEventSeq,
  latestWorkstreamOf,
  listAaModels,
  listBatches,
  listBoardColumns,
  listEventsAfter,
  listFlows,
  listInbox,
  listModelProfiles,
  listPeople,
  listPersonas,
  listProjects,
  listProjectViews,
  listRoutingRules,
  listTasks,
  listWorkstreams,
  moveTask,
  patchBoardColumn,
  patchFlow,
  patchModelProfile,
  patchPersona,
  patchProject,
  patchTask,
  resumeTask,
  runNext,
  setRoutingRules,
  setTeam,
} from '@10db/db';
import { MoveCause, type AccountMoves, type AccountService } from '../accounts';
import { syncWarning, type BenchmarkSync } from '../benchmarks';
import type { ApiServices, TaskLookupServices, TaskRemovalServices } from '../api';
import { workstreamChanges, type BatchStarter, type Shipper } from '../delivery';
import { markGhRequired } from '../environment';
import type { EventBus, StateStore } from '../events';
import { inspectFolder, proposeAreas, type AreaNamer } from '../folders';
import type { Git } from '../git';
import { requestMcpApproval, type InboxService } from '../inbox';
import type { KeepAwake } from '../keep-awake';
import type { Runner } from '../runner';
import type { Scheduler } from '../scheduler';
import { ProjectMcpError, readRepoMcp, type RepoMcp } from '../sessions';
import {
  allowFoundHosts,
  allowNetworkHost,
  listNetworkHosts,
  removeNetworkHost,
  unallowedFoundHosts,
} from '../permissions';
import { findRegistryHosts } from '../registries';
import { proposeCandidates, resolveStepPlan, retryWorkstream, startTaskWithPlan } from '../team';
import { checkoutConflictsWithRoot } from './worktree-root';

/** The HTTP layer's view of the daemon: reads go to the database, writes go through the state store. */
export function createServices(deps: {
  readonly state: StateStore;
  readonly bus: EventBus;
  readonly runner: Runner;
  readonly scheduler: Scheduler;
  readonly inbox: InboxService;
  readonly keepAwake: KeepAwake;
  /** Probes the tools and gh's login; the services keep its last answer. */
  readonly systemCheck: () => Promise<SystemCheckDto>;
  readonly benchmarks: BenchmarkSync;
  readonly starter: BatchStarter;
  readonly shipper: Shipper;
  readonly accounts: AccountService;
  readonly moves: Pick<AccountMoves, 'move'>;
  /** Where worktrees are made; a project's checkout may not overlap it. */
  readonly worktreeRoot: string;
  /** The daemon's git, for inspecting a folder before it is a project. */
  readonly git: Git;
  /** Whether origin, for the checkout at `repoPath`, has the branch. Throws when origin can't be asked. */
  readonly branchOnOrigin: (repoPath: string, branch: string) => Promise<boolean>;
  /** 10db's own places a project may not be: the data dir, the lane temp root, the worktree root. */
  readonly protectedRoots: readonly string[];
  /** Names and merges proposed areas; null leaves them named from their paths. */
  readonly areaNamer: AreaNamer | null;
  /** Records a new project's checkout as the daemon trusts it (lane sandbox spec D13). */
  readonly pinCheckout: (repoPath: string) => void;
}): ApiServices & TaskRemovalServices & TaskLookupServices {
  const db = deps.state.db;
  // The tool check and gh's login are probed on the first request and on a recheck, never otherwise.
  let lastCheck: Promise<SystemCheckDto> | null = null;

  /**
   * A task that lands in a branch other than its project's base is built from that branch, so it has
   * to be on origin; refused here, before the task exists, in the words the builder reads.
   */
  async function refuseMissingLandingBranch(
    project: ProjectDto,
    landing: TaskLanding | undefined,
  ): Promise<void> {
    if (landing?.kind !== 'branch' || project.delivery !== Delivery.PullRequest) return;
    if (landing.branch === project.baseBranch) return;
    let there: boolean;
    try {
      there = await deps.branchOnOrigin(project.repoPath, landing.branch);
    } catch (error) {
      throw new InvalidError(
        `10db couldn't ask origin whether it has ${landing.branch}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!there)
      throw new InvalidError(
        `origin has no branch named ${landing.branch}. Create it on origin, or choose another place for this task to land.`,
      );
  }
  return {
    listProjects: () => listProjectViews(db),
    async createProject(input) {
      const config = ProjectInput.parse(input);
      if (!existsSync(join(config.repoPath, '.git'))) {
        throw new InvalidError(`${config.repoPath} is not a git repository`);
      }
      if (checkoutConflictsWithRoot(deps.worktreeRoot, config.repoPath)) {
        throw new InvalidError(
          `${config.repoPath} overlaps the worktree root ${deps.worktreeRoot}: a checkout may not contain it or lie inside it. Set TENDB_WORKTREE_ROOT to a directory elsewhere.`,
        );
      }
      const project = deps.state.write((ctx) => insertProject(ctx, config));
      deps.pinCheckout(project.repoPath);
      // The registries the project's own files name are allowed from the start; reading them runs nothing.
      allowFoundHosts(deps.state, project.id, await findRegistryHosts(project.repoPath));
      return project;
    },
    listTasks: (projectId) => listTasks(db, projectId),
    async createTask(projectId, input) {
      await refuseMissingLandingBranch(getProject(db, projectId), input.landing);
      const task = deps.state.write((ctx) => insertTask(ctx, projectId, input));
      deps.scheduler.requestTick();
      return task;
    },
    holdTask: (taskId) => deps.state.write((ctx) => holdTask(ctx, taskId)),
    startTask(taskId) {
      // A held task already has its run, and its batch and worktree if it has them: it only queues again.
      const held = latestWorkstreamOf(db, taskId);
      if (held?.state === WorkstreamState.Held) {
        const workstream = deps.state.write((ctx) => resumeTask(ctx, taskId));
        deps.scheduler.requestTick();
        return { kind: 'workstream', workstream };
      }
      const project = getProject(db, getTask(db, taskId).projectId);
      if (project.delivery === Delivery.PullRequest) {
        const batch = deps.starter.startTask(taskId);
        deps.scheduler.requestTick();
        return { kind: 'batch', batch };
      }
      const workstream = startTaskWithPlan(deps.state, taskId);
      deps.scheduler.requestTick();
      return { kind: 'workstream', workstream };
    },
    runNext(taskId) {
      const result = deps.state.write((ctx) => runNext(ctx, taskId));
      deps.scheduler.requestTick();
      return result;
    },
    startBatch: (projectId, input) => deps.starter.startBatch(projectId, input),
    // The store lists oldest first; the API answers newest first.
    listBatches: (projectId) => listBatches(db, { projectId }).reverse(),
    shipBatch: (id) => deps.shipper.ship(id),
    abandonBatch: (id) => deps.shipper.abandon(id),
    listFlows: () => listFlows(db),
    listWorkstreams: ({ active }) => listWorkstreams(db, active ? { states: ACTIVE_STATES } : {}),
    async cancelWorkstream(id) {
      await deps.runner.cancel(id);
      return getWorkstream(db, id);
    },
    workstreamChanges: (id) => workstreamChanges({ db, git: deps.git }, id),
    retryWorkstream(id, note) {
      const ws = retryWorkstream(deps.state, id, note);
      if (ws.batchId !== null) deps.starter.reopen(ws.batchId);
      deps.scheduler.requestTick();
      return ws;
    },
    listInbox: ({ states, recent }) =>
      listInbox(db, {
        ...(states ? { states } : {}),
        ...(recent !== null ? { recent } : {}),
      }),
    answerInbox(id, answer) {
      const item = deps.inbox.answer(id, answer);
      deps.scheduler.requestTick();
      return item;
    },
    eventsAfter: (after, limit) => listEventsAfter(db, after, limit),
    subscribe: (listener) => deps.bus.subscribe(listener),
    systemCheck: async ({ recheck }) => {
      if (recheck || lastCheck === null) {
        const probing = deps.systemCheck();
        lastCheck = probing;
        // A failed probe is not remembered, so the next request tries again.
        probing.catch(() => {
          if (lastCheck === probing) lastCheck = null;
        });
      }
      return {
        ...markGhRequired(
          await lastCheck,
          listProjects(db).some((p) => p.delivery === Delivery.PullRequest),
        ),
        // Read per request: the tool check is kept from the first request until a recheck, but a sync can fail or recover at any time.
        benchmarkSync: syncWarning(deps.benchmarks.status()),
      };
    },
    keepAwake: () => deps.keepAwake.status(),
    setKeepAwake: (mode) => deps.keepAwake.setMode(mode),
    eventsHead: () => latestEventSeq(db),
    listNetworkHosts(projectId) {
      getProject(db, projectId);
      return listNetworkHosts(db, projectId);
    },
    allowNetworkHost: (projectId, host) => allowNetworkHost(deps.state, projectId, host),
    removeNetworkHost: (projectId, host) => removeNetworkHost(deps.state, projectId, host),
    async scanNetworkHosts(projectId) {
      const project = getProject(db, projectId);
      // Only listed: a lane may have written these files, so the builder allows each host by name.
      return unallowedFoundHosts(db, projectId, await findRegistryHosts(project.repoPath));
    },
    listPersonas: () => listPersonas(db, { includeArchived: true }),
    createPersona: (input) => deps.state.write((ctx) => insertPersona(ctx, input)),
    patchPersona: (id, patch) => deps.state.write((ctx) => patchPersona(ctx, id, patch)),
    listPeople: () => listPeople(db),
    createPerson: (input) => deps.state.write((ctx) => insertPerson(ctx, input)),
    createFlow: (input) => deps.state.write((ctx) => insertFlow(ctx, input)),
    patchFlow: (id, patch) => deps.state.write((ctx) => patchFlow(ctx, id, patch)),
    listModelProfiles: () => listModelProfiles(db),
    patchModelProfile: (id, patch) => deps.state.write((ctx) => patchModelProfile(ctx, id, patch)),
    benchmarkStatus: () => deps.benchmarks.status(),
    syncBenchmarks: () => deps.benchmarks.sync(),
    listAaModels: () => listAaModels(db),
    patchProject: (id, patch) =>
      patch.accountId === undefined
        ? deps.state.write((ctx) => patchProject(ctx, id, patch))
        : // The account through the move, with the other fields in the same write.
          deps.moves.move(id, patch.accountId, { cause: MoveCause.Builder }, { patch }),
    listAccounts: () => deps.accounts.list(),
    createAccount: (input) => deps.accounts.create(input),
    patchAccount: (id, patch) => deps.accounts.patch(id, patch),
    archiveAccount: (id) => deps.accounts.archive(id),
    setAccountSecret: (id, input) => deps.accounts.setSecret(id, input),
    accountSignIn: (id) => deps.accounts.signIn(id),
    accountIdentity: (id) => deps.accounts.identity(id),
    accountUsage: (id, month) => deps.accounts.usage(id, month),
    getTeam(projectId) {
      getProject(db, projectId);
      return getTeam(db, projectId);
    },
    setTeam: (projectId, input) => deps.state.write((ctx) => setTeam(ctx, projectId, input)),
    listRoutingRules(projectId) {
      getProject(db, projectId);
      return listRoutingRules(db, projectId);
    },
    setRoutingRules: (projectId, input) =>
      deps.state.write((ctx) => setRoutingRules(ctx, projectId, input)),
    removeTask: (id) => deps.state.write((ctx) => cancelTask(ctx, id)),
    getTask: (id) => getTask(db, id),
    closeTask: (id) => deps.state.write((ctx) => closeTask(ctx, id)),
    reopenTask: (id) => deps.state.write((ctx) => reopenTask(ctx, id)),
    async patchTask(id, patch) {
      await refuseMissingLandingBranch(getProject(db, getTask(db, id).projectId), patch.landing);
      return deps.state.write((ctx) => patchTask(ctx, id, patch));
    },
    moveTask: (id, move) => deps.state.write((ctx) => moveTask(ctx, id, move)),
    listBoardColumns(projectId) {
      getProject(db, projectId);
      return listBoardColumns(db, projectId);
    },
    createBoardColumn(projectId, input) {
      getProject(db, projectId);
      return deps.state.write((ctx) => insertBoardColumn(ctx, projectId, input));
    },
    patchBoardColumn: (id, patch) => deps.state.write((ctx) => patchBoardColumn(ctx, id, patch)),
    deleteBoardColumn: (id, del) => deps.state.write((ctx) => deleteBoardColumn(ctx, id, del)),
    stepPlan: (taskId) => resolveStepPlan(db, taskId),
    proposeCandidates: (projectId, size) => proposeCandidates(db, projectId, size),
    inspectFolder: (path) =>
      inspectFolder(
        {
          git: deps.git,
          projects: listProjects(db),
          protectedRoots: deps.protectedRoots,
          registryHosts: findRegistryHosts,
        },
        path,
      ),
    proposeAreas: (path) =>
      proposeAreas(
        { git: deps.git, namer: deps.areaNamer, protectedRoots: deps.protectedRoots },
        path,
      ),
    reviewProjectMcp(projectId) {
      const project = getProject(db, projectId);
      let repo: RepoMcp;
      try {
        repo = readRepoMcp(project.repoPath);
      } catch (error) {
        throw error instanceof ProjectMcpError ? new InvalidError(error.message) : error;
      }
      return repo.servers.map(({ review }): McpServerStatusDto => {
        const approval = getMcpApproval(db, projectId, review.name, review.configHash);
        if (approval) return { ...review, verdict: approval.verdict, inboxId: null };
        return {
          ...review,
          verdict: 'pending',
          inboxId: requestMcpApproval(deps.inbox, projectId, review).id,
        };
      });
    },
  };
}
