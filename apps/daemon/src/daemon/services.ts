import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACTIVE_STATES,
  AreaRole,
  CatalogueAttempt,
  type CatalogueStatusDto,
  type BatchId,
  ConflictError,
  Delivery,
  TaskStatus,
  InvalidError,
  isDaemonAddress,
  APP_URL_IS_DAEMON,
  type McpServerStatusDto,
  ProjectInput,
  PassState,
  SharedChoiceKind,
  ProjectLanding,
  type ProjectDto,
  type ProjectPatch,
  WorkstreamState,
  type SystemCheckDto,
  type PassAbandonedDto,
  type PassSignOffDto,
  type PassId,
  type PassJoinRequest,
  type TakeOutResultDto,
  type TaskId,
  TaskMessageId,
  TaskMessageKind,
  type TaskLanding,
  type WorkstreamId,
} from '@10db/contracts';
import {
  BUILDER_CHOSE_PLACEMENT,
  cancelTask,
  closeTask,
  reopenTask,
  deleteBoardColumn,
  getGoal,
  getMcpApproval,
  getProject,
  getSmallProposalLimit,
  setSmallProposalLimit,
  getPass,
  getPassProgress,
  getTask,
  getTeam,
  getWorkstream,
  holdTask,
  insertBoardColumn,
  insertBuilderMessage,
  insertFlow,
  insertPerson,
  insertPersona,
  insertProject,
  insertTask,
  latestEventSeq,
  humanTouchDays,
  latestWorkstreamOf,
  openGoalDigest,
  listAaModels,
  listAccountModels,
  listAccounts,
  listBatches,
  listBoardColumns,
  listEventsAfter,
  listFlows,
  listGoalSummaries,
  listInbox,
  listModelProfiles,
  listPeople,
  listPersonas,
  listProjects,
  listProjectViews,
  listRoutingRules,
  listTasks,
  listTaskThread,
  listWorkstreams,
  moveTask,
  listPassTasks,
  openPassTurn,
  passHoldingTask,
  patchBoardColumn,
  patchFlow,
  patchModelProfile,
  patchPersona,
  patchProject,
  patchTask,
  renamePass,
  resumeTask,
  runNext,
  setRoutingRules,
  setTeam,
  takeOffer,
  undoHazardAddition,
  offeredText,
  offerToAgent,
} from '@10db/db';
import { MoveCause, type AccountMoves, type AccountService } from '../accounts';
import type { Clock } from '../clock';
import { syncWarning, type BenchmarkSync } from '../benchmarks';
import { buildModelRows, type CatalogueSync } from '../catalogue';
import { proposePlacement } from '../placement';
import type { ApiServices, TaskLookupServices, TaskRemovalServices, TaskStarted } from '../api';
import {
  createFailedRestarts,
  workstreamChanges,
  type BatchStarter,
  type PassOpened,
  type PassOpenInput,
  type PassPullRequests,
  type Shipper,
} from '../delivery';
import { markGhRequired, withAgentStatus, type AgentTools } from '../environment';
import type { EventBus, StateStore } from '../events';
import { inspectFolder, proposeAreas, proposeSetupAreas, type AreaNamer } from '../folders';
import { adoptGoal } from '../goals';
import { GitError, type Git } from '../git';
import { hazardAssessmentDto, type HazardAssessor } from '../hazards';
import { earlierMcpApproval, requestMcpApproval, type InboxService } from '../inbox';
import {
  createTurnFiles,
  goalPassPages,
  livePassViews,
  openTurn,
  passStartPreview,
  passView,
  sharedUnlanded,
  TakeOutWithin,
  taskTurns,
  turnLog,
  type PassCloses,
  type PassJoined,
  type TakeOutInput,
} from '../pass';
import type { KeepAwake } from '../keep-awake';
import type { Runner } from '../runner';
import type { Scheduler } from '../scheduler';
import { ProjectMcpError, readRepoMcp, type RepoMcp } from '../sessions';
import {
  allowFoundHosts,
  allowNetworkHost,
  laneAutoMode,
  listNetworkHosts,
  removeNetworkHost,
  setLaneAutoMode,
  unallowedFoundHosts,
} from '../permissions';
import { findRegistryHosts } from '../registries';
import { proposeCandidates, resolveStepPlan, startTaskWithPlan } from '../team';
import type { Pictures } from '../pictures';
import type { Preview } from '../preview';
import type { ThreadService } from '../thread';
import type { JudgeApiServices } from './judge-services';
import type { KnowledgeApiServices } from './knowledge-services';
import { createModelSettingsServices } from './model-settings-services';
import type { ShapeApiServices } from './shape-services';
import { gateCallsDocker } from './docker-need';
import type { ListenerReader } from './listening-ports';
import type { AddressProbe } from './loopback-probe';
import { suggestSettings } from './suggest-settings';
import { checkoutConflictsWithRoot } from './worktree-root';

/** The HTTP layer's view of the daemon: reads go to the database, writes go through the state store. */
export function createServices(deps: {
  readonly state: StateStore;
  readonly clock: Clock;
  readonly bus: EventBus;
  readonly runner: Runner;
  readonly scheduler: Scheduler;
  readonly inbox: InboxService;
  readonly keepAwake: KeepAwake;
  /** Probes the tools and gh's login; the services keep its last answer. */
  readonly systemCheck: () => Promise<SystemCheckDto>;
  /** The pinned Claude Code and Codex, read for each request; null where none are managed. */
  readonly agents: AgentTools | null;
  readonly benchmarks: BenchmarkSync;
  /** The model catalogue in use, for the model list's names and runnability. */
  readonly catalogue: Pick<CatalogueSync, 'status' | 'catalogue'>;
  /** Fetches the catalogue and reads every account's list; a call during a run joins it. */
  readonly refreshModels: (opts: { readonly force: boolean }) => Promise<void>;
  /** Whether this daemon fetches the catalogue at all; off, the status says so. */
  readonly catalogueOn: boolean;
  readonly judge: JudgeApiServices;
  readonly shape: ShapeApiServices;
  readonly knowledge: KnowledgeApiServices;
  readonly thread: ThreadService;
  readonly pictures: Pictures;
  /** The dev server 10db runs for a project while a pass is open. */
  readonly preview: Preview;
  /** The port the API listens on; null until it does. */
  readonly daemonPort: () => number | null;
  readonly starter: BatchStarter;
  /** Opens a pass in the project's delivery queue (`openPass` with its lease and put-back). */
  readonly openPass: (input: PassOpenInput) => Promise<PassOpened>;
  /** Takes a task out of its pass in the project's delivery queue, stopping its lane through the runner. */
  readonly takeOut: (input: TakeOutInput) => Promise<TakeOutResultDto>;
  /** Abandons a pass in the project's delivery queue, stopping its lanes through the runner. */
  readonly abandonPass: (passId: PassId) => Promise<PassAbandonedDto>;
  /** Adds pages to an open pass in the project's delivery queue (`joinPass` with its lease and put-back). */
  readonly joinPass: (passId: PassId, input: PassJoinRequest) => Promise<PassJoined>;
  /** Discards a task's saved Workbench work in its project's delivery queue. */
  readonly discardKeptWork: (taskId: TaskId) => Promise<void>;
  /** A pass's pull request: its preview, and Open Pull Request. */
  readonly passPullRequests: Pick<PassPullRequests, 'preview' | 'open'>;
  /** A pass's close: its lists and its confirm, which queues the close in the delivery queue. */
  readonly closes: Pick<PassCloses, 'preview' | 'close' | 'continueClose'>;
  /** Signs off a Ready page in the project's delivery queue, stopping its lane through the runner. */
  readonly signOff: (passId: PassId, taskId: TaskId) => PassSignOffDto;
  /** Cancels a page's waiting sign-off. */
  readonly cancelSignOff: (passId: PassId, taskId: TaskId) => void;
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
  /** What listens on this Mac, for the Workbench setup's app address. */
  readonly listeners: ListenerReader;
  /** Whether something answers at a loopback address, for the Workbench setup's app address. */
  readonly probe: AddressProbe;
  /** Works out each project's hazards from its repository. */
  readonly hazards: Pick<HazardAssessor, 'assess'>;
  /** Records a new project's checkout as the daemon trusts it (lane sandbox spec D13). */
  readonly pinCheckout: (repoPath: string) => void;
}): ApiServices & TaskRemovalServices & TaskLookupServices {
  const db = deps.state.db;
  const restarts = createFailedRestarts(deps);
  const catalogueStatus = (): CatalogueStatusDto => ({
    ...deps.catalogue.status(),
    ...(deps.catalogueOn ? {} : { lastAttempt: CatalogueAttempt.Off }),
  });
  // A turn's files are read once per pair of kept commits, which never change.
  const turnFiles = createTurnFiles(deps.git);
  // The tool check and gh's login are probed on the first request and on a recheck, never otherwise.
  let lastCheck: Promise<SystemCheckDto> | null = null;

  /**
   * A task that lands in a branch other than its project's base is built from that branch, so it has
   * to be on origin; refused here, before the task exists, in the words the builder reads.
   */
  async function refuseMissingBranch(
    project: Pick<ProjectDto, 'repoPath' | 'baseBranch' | 'delivery'>,
    branch: string,
    elsewhere: string,
  ): Promise<void> {
    if (project.delivery !== Delivery.PullRequest || branch === project.baseBranch) return;
    let there: boolean;
    try {
      there = await deps.branchOnOrigin(project.repoPath, branch);
    } catch (error) {
      throw new InvalidError(
        `10db couldn't ask origin whether it has ${branch}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!there)
      throw new InvalidError(
        `origin has no branch named ${branch}. Create it on origin, or choose another place for ${elsewhere} to land.`,
      );
  }

  async function refuseMissingLandingBranch(
    project: ProjectDto,
    landing: TaskLanding | undefined,
  ): Promise<void> {
    if (landing?.kind !== 'branch') return;
    await refuseMissingBranch(project, landing.branch, 'this task');
  }

  /** The same refusal for a project default that names a branch, when a patch or a new project sets it. */
  async function refuseMissingDefaultBranch(
    project: Pick<ProjectDto, 'repoPath' | 'baseBranch' | 'delivery' | 'landing' | 'landingBranch'>,
    patch: Pick<ProjectPatch, 'landing' | 'landingBranch' | 'delivery' | 'baseBranch'>,
  ): Promise<void> {
    if (patch.landing === undefined && patch.landingBranch === undefined) return;
    const landing = patch.landing ?? project.landing;
    const branch = patch.landingBranch ?? project.landingBranch;
    if (landing !== ProjectLanding.Branch || branch === null) return;
    await refuseMissingBranch(
      {
        repoPath: project.repoPath,
        baseBranch: patch.baseBranch ?? project.baseBranch,
        delivery: patch.delivery ?? project.delivery,
      },
      branch,
      'new tasks',
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
      await refuseMissingDefaultBranch(
        { ...config, landingBranch: null, landing: ProjectLanding.Merge },
        config,
      );
      const project = deps.state.write((ctx) => insertProject(ctx, config));
      deps.pinCheckout(project.repoPath);
      // The registries the project's own files name are allowed from the start; reading them runs nothing.
      allowFoundHosts(deps.state, project.id, await findRegistryHosts(project.repoPath));
      return project;
    },
    listTasks: (projectId) => listTasks(db, projectId),
    async createTask(projectId, input) {
      await refuseMissingLandingBranch(getProject(db, projectId), input.landing);
      const task = deps.state.write((ctx) =>
        insertTask(
          ctx,
          projectId,
          input,
          proposePlacement(getProject(ctx.tx, projectId), {
            areas: input.areas,
            riskTags: input.riskTags ?? [],
            workspaceMode: input.workspaceMode,
          }),
        ),
      );
      deps.scheduler.requestTick();
      return task;
    },
    holdTask: (taskId) => deps.state.write((ctx) => holdTask(ctx, taskId)),
    startTask(taskId, input) {
      // A held task already has its run, and its batch and worktree if it has them: it only queues again.
      const held = latestWorkstreamOf(db, taskId);
      if (held?.state === WorkstreamState.Held) {
        const workstream = deps.state.write((ctx) => resumeTask(ctx, taskId));
        deps.scheduler.requestTick();
        return { kind: 'workstream', workstream };
      }
      // A failed run in an open batch is run again in it, as the failure card's Retry does, unless
      // the builder asked to start over: then the batch holding only that attempt ends first. The same
      // when the task's placement moved since: a retry would stay in the batch, where the task no
      // longer runs, so it starts over in its new placement, unless its landing holds it there, which
      // supersede refuses saying so.
      let left: BatchId | null = null;
      if (input?.fresh || restarts.placementMoved(taskId)) left = restarts.supersede(taskId);
      else {
        const retried = restarts.continueRun(taskId);
        if (retried) {
          deps.scheduler.requestTick();
          return { kind: 'workstream', workstream: retried };
        }
      }
      // Here a new run replaces the failed one, whether the builder started over or its batch
      // couldn't take it again (none, or no longer open).
      const superseded: WorkstreamId | null =
        held?.state === WorkstreamState.Failed ? held.id : null;
      const project = getProject(db, getTask(db, taskId).projectId);
      const started: TaskStarted =
        project.delivery === Delivery.PullRequest
          ? { kind: 'batch', batch: deps.starter.startTask(taskId) }
          : { kind: 'workstream', workstream: startTaskWithPlan(deps.state, taskId) };
      // The batch it left no longer waits on the attempt it started over from.
      if (left) deps.shipper.checkBatch(left);
      // The failed run is left behind by the new one; its card's Retry would be refused.
      if (superseded) deps.inbox.cancelForWorkstream(superseded);
      deps.scheduler.requestTick();
      return started;
    },
    runNext(taskId) {
      const result = deps.state.write((ctx) => runNext(ctx, taskId));
      deps.scheduler.requestTick();
      return result;
    },
    startBatch: (projectId, input) => deps.starter.startBatch(projectId, input),
    // The store lists oldest first; the API answers newest first.
    listBatches: (projectId) => listBatches(db, { projectId }).reverse(),
    async openPass(projectId, input) {
      let opened: PassOpened;
      try {
        opened = await deps.openPass({
          projectId,
          name: input.name,
          taskIds: input.taskIds,
          ...(input.pageCap === undefined ? {} : { pageCap: input.pageCap }),
          ...(input.pages === undefined ? {} : { pages: input.pages }),
          ...(input.goalId === undefined ? {} : { goalId: input.goalId }),
        });
      } catch (error) {
        if (error instanceof GitError)
          throw new ConflictError(`Your folder could not be opened for a pass: ${error.message}`);
        throw error;
      }
      // Each page's first turn starts from a message: the builder's, else the task's description. A
      // page the open made a task for has none, so it waits for the builder's first word.
      deps.state.write((ctx) => {
        for (const task of listPassTasks(ctx.tx, opened.pass.id)) {
          const body = input.firstMessage ?? task.description;
          if (body.trim() !== '') insertBuilderMessage(ctx, task.id, { body, files: [] });
        }
      });
      deps.scheduler.requestTick();
      return { ...opened, dirt: [...opened.dirt], waiting: [...opened.waiting] };
    },
    passView: (passId) => passView(db, passId),
    async takeOutPage(passId, taskId, input) {
      const pass = getPass(db, passId);
      const task = getTask(db, taskId);
      if (pass.state !== PassState.Open)
        throw new ConflictError(
          `Pass "${pass.name}" is ${pass.state.toLowerCase()}: a page is taken out only while it is open`,
        );
      if (passHoldingTask(db, task)?.id !== passId)
        throw new ConflictError(`${task.title} is not a page of pass "${pass.name}"`);
      // A Drop is taken only for a change of the page the preview offers it for.
      const offered = new Map(
        (await sharedUnlanded(deps, { passId, taskId })).map((c) => [c.seq, c.dropRefusal]),
      );
      for (const choice of input.shared) {
        if (choice.choice !== SharedChoiceKind.Drop) continue;
        if (!offered.has(choice.seq))
          throw new ConflictError(
            `Shared change ${String(choice.seq)} is not one of ${task.title}'s that has not landed`,
          );
        const refused = offered.get(choice.seq);
        if (refused)
          throw new ConflictError(
            `Shared change ${String(choice.seq)} cannot be dropped: ${refused}`,
          );
      }
      return deps.takeOut({ taskId, within: TakeOutWithin.Alone, shared: input.shared });
    },
    async takeOutPreview(passId, taskId) {
      const pass = getPass(db, passId);
      const task = getTask(db, taskId);
      if (passHoldingTask(db, task)?.id !== passId)
        throw new ConflictError(`${task.title} is not a page of pass "${pass.name}"`);
      return { shared: await sharedUnlanded(deps, { passId, taskId }) };
    },
    abandonPass(passId) {
      const pass = getPass(db, passId);
      const states: readonly PassState[] = [
        PassState.Open,
        PassState.Closing,
        PassState.Abandoning,
      ];
      if (!states.includes(pass.state))
        throw new ConflictError(
          `Pass "${pass.name}" is ${pass.state.toLowerCase()}: only an open or closing pass is abandoned`,
        );
      return deps.abandonPass(passId);
    },
    livePasses: () => livePassViews(db),
    passStart: (projectId) =>
      passStartPreview(
        { db, git: deps.git, gateCallsDocker: (project) => gateCallsDocker(deps.git, project) },
        projectId,
      ),
    async addPassPages(passId, input) {
      await deps.joinPass(passId, input);
      deps.scheduler.requestTick();
      return passView(db, passId);
    },
    renamePass: (passId, input) => deps.state.write((ctx) => renamePass(ctx, passId, input.name)),
    discardKeptWork: (taskId) => deps.discardKeptWork(taskId),
    goalPassPages: (goalId) => goalPassPages({ db, git: deps.git }, goalId),
    taskTurns: (taskId) => taskTurns({ db, git: deps.git, files: turnFiles }, taskId),
    turnActivity: (turnId) => turnLog(db, turnId),
    openedTurn: (taskId, turnId) => {
      openTurn(deps.state, taskId, turnId);
    },
    workbenchSetup: async (projectId, signal) => {
      const project = getProject(db, projectId);
      const open = listTasks(db, projectId).filter((t) => t.status === TaskStatus.Open);
      const areas = await proposeSetupAreas({ git: deps.git }, project, open, signal);
      const pages = areas.proposed.filter((a) => a.role === AreaRole.Page).map((a) => a.globs);
      const suggested = await suggestSettings(
        {
          git: deps.git,
          listeners: deps.listeners,
          probe: deps.probe,
          asker: deps.areaNamer,
          daemonPort: deps.daemonPort,
        },
        project,
        pages,
        signal,
      );
      return { areas, ...suggested };
    },
    passClosePreview: (passId) => deps.closes.preview(passId),
    closePass: (passId, input) => deps.closes.close(passId, input),
    continueClose: (passId) => deps.closes.continueClose(passId),
    signOffPage: (passId, taskId) => deps.signOff(passId, taskId),
    cancelSignOff: (passId, taskId) => {
      deps.cancelSignOff(passId, taskId);
    },
    passPullRequest: (passId) => deps.passPullRequests.preview(passId),
    openPassPullRequest: (passId) => deps.passPullRequests.open(passId),
    async sendToAgent(taskId, noticeId) {
      const task = getTask(db, taskId);
      const message = TaskMessageId.safeParse(noticeId);
      const onThread =
        message.success &&
        listTaskThread(db, taskId).some(
          (m) => m.id === message.data && m.kind === TaskMessageKind.Notice,
        )
          ? offeredText(db, message.data)
          : null;
      const pass = passHoldingTask(db, task);
      const inHeader =
        pass === undefined
          ? null
          : (getPassProgress(db, pass.id).notices.find((n) => n.id === noticeId && n.sendable)
              ?.text ?? null);
      const text = onThread ?? inHeader;
      if (text === null) throw new ConflictError('That notice offers nothing to send to the agent');
      // A thread notice is sent once: its offer is taken as it is sent, and put back if the send fails.
      const offered = message.success && onThread !== null ? message.data : null;
      if (offered !== null && deps.state.write((ctx) => takeOffer(ctx, offered)) === null)
        throw new ConflictError('That notice was sent to the agent already');
      try {
        return await deps.thread.postTaskMessage(taskId, { text, pictures: [] });
      } catch (error) {
        if (offered !== null)
          deps.state.write((ctx) => {
            offerToAgent(ctx, offered, text);
          });
        throw error;
      }
    },
    async stopPage(taskId) {
      const task = getTask(db, taskId);
      const pass = passHoldingTask(db, task);
      if (pass?.state !== PassState.Open)
        throw new ConflictError(`${task.title} is not a page of an open UI Workbench pass`);
      if (task.workstreamId === null) return;
      // A turn running, or a lane starting one: a page waiting for the builder is left as it is.
      const working =
        openPassTurn(db, taskId) !== undefined ||
        (deps.runner.isRunning(task.workstreamId) &&
          getWorkstream(db, task.workstreamId).state !== WorkstreamState.WaitingHuman);
      if (working) await deps.runner.stopPassLane(task.workstreamId);
    },
    listGoals: (projectId) => listGoalSummaries(db, projectId),
    humanTouch: (projectId) => {
      getProject(db, projectId);
      return { days: humanTouchDays(db, projectId, deps.clock.now()) };
    },
    // The view mark advances in the same transaction that reads the window it closes.
    openGoalDigest: (goalId) => deps.state.write((ctx) => openGoalDigest(ctx, goalId)),
    shipBatch: (id) => deps.shipper.ship(id),
    abandonBatch: (id) => deps.shipper.abandon(id),
    adoptGoal: (projectId, input) => adoptGoal(deps, projectId, input),
    getGoal: (id) => getGoal(db, id),
    listFlows: () => listFlows(db),
    listWorkstreams: ({ active }) => listWorkstreams(db, active ? { states: ACTIVE_STATES } : {}),
    async cancelWorkstream(id) {
      await deps.runner.cancel(id);
      return getWorkstream(db, id);
    },
    workstreamChanges: (id) => workstreamChanges({ db, git: deps.git }, id),
    retryWorkstream(id, note) {
      const ws = deps.starter.retry(id, note);
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
      // A recheck starts fetching again a copy that failed and asks upstream for its newest release; the
      // answer says a copy is fetching rather than waiting on its download.
      if (recheck) await deps.agents?.retry();
      const checked = markGhRequired(
        await lastCheck,
        listProjects(db).some((p) => p.delivery === Delivery.PullRequest),
      );
      return {
        // The pinned copies are read per request: they are fetched in the background and upstream moves on.
        ...(deps.agents ? withAgentStatus(checked, deps.agents.statuses()) : checked),
        // Read per request: the tool check is kept from the first request until a recheck, but a sync can fail or recover at any time.
        benchmarkSync: syncWarning(deps.benchmarks.status()),
      };
    },
    keepAwake: () => deps.keepAwake.status(),
    setKeepAwake: (mode) => deps.keepAwake.setMode(mode),
    lanePermissions: () => ({ autoMode: laneAutoMode(db) }),
    setLanePermissions(autoMode) {
      deps.state.write((ctx) => {
        setLaneAutoMode(ctx, autoMode);
      });
      return { autoMode };
    },
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
    getHazardAssessment(projectId) {
      getProject(db, projectId);
      return hazardAssessmentDto(db, projectId);
    },
    async lookAgainAtHazards(projectId, signal) {
      getProject(db, projectId);
      const outcome = await deps.hazards.assess(projectId, signal);
      return outcome.ok
        ? { ok: true, assessment: hazardAssessmentDto(db, projectId), added: outcome.added }
        : { ok: false, message: outcome.message };
    },
    undoHazardAddition(projectId, additionId) {
      getProject(db, projectId);
      deps.state.write((ctx) => {
        undoHazardAddition(ctx, projectId, additionId);
      });
      return hazardAssessmentDto(db, projectId);
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
    ...deps.judge,
    ...createModelSettingsServices(deps.state),
    ...deps.shape,
    ...deps.knowledge,
    ...deps.thread,
    taskScreens: (taskId) => deps.pictures.screens(taskId),
    screenPicture: (screenId) => deps.pictures.screenFile(screenId),
    picturesStatus: (projectId) => deps.pictures.status(projectId),
    restartPreview: async (projectId) => {
      getProject(db, projectId);
      await deps.preview.restart(projectId);
    },
    benchmarkStatus: () => deps.benchmarks.status(),
    syncBenchmarks: () => deps.benchmarks.sync(),
    listAaModels: () => listAaModels(db),
    listModels: () =>
      buildModelRows({
        profiles: listModelProfiles(db),
        offers: listAccountModels(db),
        accounts: listAccounts(db),
        catalogue: deps.catalogue.catalogue(),
      }),
    listAccountOffers: () => listAccountModels(db),
    catalogueStatus,
    // The builder asked, so every account is read whatever the day's earlier reads were.
    refreshModels: async () => {
      await deps.refreshModels({ force: true });
      return catalogueStatus();
    },
    async patchProject(id, patch) {
      // A page loaded at 10db's own port would reach its API with the dev session.
      const port = deps.daemonPort();
      if (patch.appUrl != null && port !== null && isDaemonAddress(patch.appUrl, port))
        throw new InvalidError(APP_URL_IS_DAEMON);
      await refuseMissingDefaultBranch(getProject(db, id), patch);
      return patch.accountId === undefined
        ? deps.state.write((ctx) => patchProject(ctx, id, patch))
        : // The account through the move, with the other fields in the same write.
          deps.moves.move(id, patch.accountId, { cause: MoveCause.Builder }, { patch });
    },
    listAccounts: () => deps.accounts.list(),
    createAccount: (input) => deps.accounts.create(input),
    patchAccount: (id, patch) => deps.accounts.patch(id, patch),
    archiveAccount: (id) => deps.accounts.archive(id),
    setAccountSecret: (id, input) => deps.accounts.setSecret(id, input),
    accountSignIn: (id) => deps.accounts.signIn(id),
    accountIdentity: (id) => deps.accounts.identity(id),
    connectingAccount: () => deps.accounts.connecting(),
    connectAccount: (id) => deps.accounts.connect(id),
    cancelAccountConnect: (id) => deps.accounts.cancelConnect(id),
    accountUsage: (id, month) => deps.accounts.usage(id, month),
    listAccountPauses: () => deps.accounts.pauses(),
    resumeAccount: (id) => deps.accounts.resume(id),
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
    getSmallProposalLimit(projectId) {
      getProject(db, projectId);
      return { limit: getSmallProposalLimit(db, projectId) };
    },
    setSmallProposalLimit(projectId, input) {
      deps.state.write((ctx) => {
        getProject(ctx.tx, projectId);
        setSmallProposalLimit(ctx, projectId, input.limit);
      });
      return { limit: input.limit };
    },
    removeTask: (id) => deps.state.write((ctx) => cancelTask(ctx, id)),
    getTask: (id) => getTask(db, id),
    getWorkstream: (id) => getWorkstream(db, id),
    closeTask: (id) => deps.state.write((ctx) => closeTask(ctx, id)),
    reopenTask: (id) => deps.state.write((ctx) => reopenTask(ctx, id)),
    async patchTask(id, patch) {
      await refuseMissingLandingBranch(getProject(db, getTask(db, id).projectId), patch.landing);
      // The store refuses a task that has started; a join still pending has not written yet.
      if (patch.workspaceMode !== undefined || patch.areas !== undefined)
        deps.starter.refuseIfJoining(id);
      // The areas or risk tags can now match the placement rule. The store moves the task to a separate
      // copy only if it hasn't started and the builder hasn't placed it.
      return deps.state.write((ctx) => {
        const task = getTask(ctx.tx, id);
        const proposed =
          patch.areas === undefined && patch.riskTags === undefined
            ? undefined
            : proposePlacement(getProject(ctx.tx, task.projectId), {
                areas: patch.areas ?? task.areas,
                riskTags: patch.riskTags ?? task.riskTags,
              });
        // A join still pending has not written yet, so the move would collide with it.
        // The same holds for any move the rule makes: a task the builder placed never moves, and one with
        // no reason moves only when the rule matched.
        if (
          proposed !== undefined &&
          proposed.workspaceMode !== task.workspaceMode &&
          task.placementReason !== BUILDER_CHOSE_PLACEMENT &&
          (task.placementReason !== null || proposed.reason !== null)
        )
          deps.starter.refuseIfJoining(id);
        return patchTask(ctx, id, patch, proposed);
      });
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
    proposeCandidates: (projectId, size, goalId) => proposeCandidates(db, projectId, size, goalId),
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
    proposeAreas: (path, signal) =>
      proposeAreas(
        { git: deps.git, namer: deps.areaNamer, protectedRoots: deps.protectedRoots },
        path,
        signal,
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
          inboxId: requestMcpApproval(
            deps.inbox,
            projectId,
            review,
            earlierMcpApproval(db, projectId, review.name),
          ).id,
        };
      });
    },
  };
}
