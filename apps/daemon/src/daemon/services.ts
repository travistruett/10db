import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACTIVE_STATES,
  InvalidError,
  type McpServerStatusDto,
  ProjectInput,
  type SystemCheckDto,
} from '@10db/contracts';
import {
  getMcpApproval,
  getProject,
  getTeam,
  getWorkstream,
  insertFlow,
  insertPerson,
  insertPersona,
  insertProject,
  insertTask,
  latestEventSeq,
  listAaModels,
  listEventsAfter,
  listFlows,
  listInbox,
  listModelProfiles,
  listPeople,
  listPersonas,
  listProjects,
  listRoutingRules,
  listTasks,
  listWorkstreams,
  patchFlow,
  patchModelProfile,
  patchPersona,
  patchProject,
  patchTask,
  setRoutingRules,
  setTeam,
} from '@10db/db';
import type { BenchmarkSync } from '../benchmarks';
import type { ApiServices } from '../api';
import type { EventBus, StateStore } from '../events';
import { requestMcpApproval, type InboxService } from '../inbox';
import type { KeepAwake } from '../keep-awake';
import type { Runner } from '../runner';
import type { Scheduler } from '../scheduler';
import { ProjectMcpError, readRepoMcp, type RepoMcp } from '../sessions';
import { resolveStepPlan, retryWorkstream, startTaskWithPlan } from '../team';

/** The HTTP layer's view of the daemon: reads go to the database, writes go through the state store. */
export function createServices(deps: {
  readonly state: StateStore;
  readonly bus: EventBus;
  readonly runner: Runner;
  readonly scheduler: Scheduler;
  readonly inbox: InboxService;
  readonly keepAwake: KeepAwake;
  readonly systemCheck: () => Promise<SystemCheckDto>;
  readonly benchmarks: BenchmarkSync;
}): ApiServices {
  const db = deps.state.db;
  return {
    listProjects: () => listProjects(db),
    createProject(input) {
      const config = ProjectInput.parse(input);
      if (!existsSync(join(config.repoPath, '.git'))) {
        throw new InvalidError(`${config.repoPath} is not a git repository`);
      }
      return deps.state.write((ctx) => insertProject(ctx, config));
    },
    listTasks: (projectId) => listTasks(db, projectId),
    createTask(projectId, input) {
      const task = deps.state.write((ctx) => insertTask(ctx, projectId, input));
      deps.scheduler.requestTick();
      return task;
    },
    startTask(taskId) {
      const ws = startTaskWithPlan(deps.state, taskId);
      deps.scheduler.requestTick();
      return ws;
    },
    listFlows: () => listFlows(db),
    listWorkstreams: ({ active }) => listWorkstreams(db, active ? { states: ACTIVE_STATES } : {}),
    async cancelWorkstream(id) {
      await deps.runner.cancel(id);
      return getWorkstream(db, id);
    },
    retryWorkstream(id) {
      const ws = retryWorkstream(deps.state, id);
      deps.scheduler.requestTick();
      return ws;
    },
    listInbox: ({ states }) => listInbox(db, states ? { states } : {}),
    answerInbox(id, answer) {
      const item = deps.inbox.answer(id, answer);
      deps.scheduler.requestTick();
      return item;
    },
    eventsAfter: (after, limit) => listEventsAfter(db, after, limit),
    subscribe: (listener) => deps.bus.subscribe(listener),
    systemCheck: () => deps.systemCheck(),
    keepAwake: () => deps.keepAwake.status(),
    setKeepAwake: (mode) => deps.keepAwake.setMode(mode),
    eventsHead: () => latestEventSeq(db),
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
    patchProject: (id, patch) => deps.state.write((ctx) => patchProject(ctx, id, patch)),
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
    patchTask: (id, patch) => deps.state.write((ctx) => patchTask(ctx, id, patch)),
    stepPlan: (taskId) => resolveStepPlan(db, taskId),
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
