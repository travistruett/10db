import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACTIVE_STATES,
  ConflictError,
  InvalidError,
  type McpServerStatusDto,
  ProjectInput,
  WorkstreamState,
  type SystemCheckDto,
} from '@10db/contracts';
import {
  getMcpApproval,
  getProject,
  getWorkstream,
  getWorkstreamRow,
  insertProject,
  insertTask,
  insertWorkstream,
  latestEventSeq,
  latestHandoff,
  listEventsAfter,
  listInbox,
  listProjects,
  listTasks,
  listWorkstreams,
  transitionWorkstream,
} from '@10db/db';
import type { ApiServices } from '../api';
import type { EventBus, StateStore } from '../events';
import { requestMcpApproval, type InboxService } from '../inbox';
import type { KeepAwake } from '../keep-awake';
import type { Runner } from '../runner';
import type { Scheduler } from '../scheduler';
import { ProjectMcpError, readRepoMcp, type RepoMcp } from '../sessions';

/** The HTTP layer's view of the daemon: reads go to the database, writes go through the state store. */
export function createServices(deps: {
  readonly state: StateStore;
  readonly bus: EventBus;
  readonly runner: Runner;
  readonly scheduler: Scheduler;
  readonly inbox: InboxService;
  readonly keepAwake: KeepAwake;
  readonly systemCheck: () => Promise<SystemCheckDto>;
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
      const ws = deps.state.write((ctx) => insertWorkstream(ctx, taskId));
      deps.scheduler.requestTick();
      return ws;
    },
    listWorkstreams: ({ active }) => listWorkstreams(db, active ? { states: ACTIVE_STATES } : {}),
    async cancelWorkstream(id) {
      await deps.runner.cancel(id);
      return getWorkstream(db, id);
    },
    retryWorkstream(id) {
      if (getWorkstreamRow(db, id).state !== WorkstreamState.Failed) {
        throw new ConflictError('Only a failed workstream can be retried');
      }
      const latest = latestHandoff(db, id);
      const ws = deps.state.write((ctx) =>
        transitionWorkstream(ctx, id, {
          to: WorkstreamState.Queued,
          fence: null,
          patch: {
            attempt: 0,
            recoveryAttempts: 0,
            failureReason: null,
            nextAction: latest
              ? { kind: 'continue_from_handoff', handoffId: latest.id }
              : { kind: 'start' },
          },
          reason: 'retried by the builder',
        }),
      );
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
