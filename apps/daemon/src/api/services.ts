import type {
  AaModelDto,
  BenchmarkStatusDto,
  DaemonEvent,
  FlowDto,
  FlowId,
  FlowInput,
  FlowPatch,
  InboxAnswer,
  InboxItemDto,
  InboxItemId,
  InboxState,
  KeepAwakeMode,
  KeepAwakeStatus,
  McpServerStatusDto,
  ModelProfileDto,
  ModelProfileId,
  ModelProfilePatch,
  PersonaDto,
  PersonaId,
  PersonaInput,
  PersonaPatch,
  PersonDto,
  PersonInput,
  ProjectDto,
  ProjectId,
  ProjectInput,
  ProjectPatch,
  RoutingRuleDto,
  RoutingRulesInput,
  StepPlanDto,
  SystemCheckDto,
  TaskDto,
  TaskId,
  TaskInput,
  TaskPatch,
  TeamDto,
  TeamInput,
  WorkstreamDto,
  WorkstreamId,
} from '@10db/contracts';

/** What the HTTP layer needs from the daemon. Implemented in the daemon module. */
export interface ApiServices {
  listProjects(): ProjectDto[];
  createProject(input: ProjectInput): ProjectDto;
  listTasks(projectId: ProjectId): TaskDto[];
  createTask(projectId: ProjectId, input: TaskInput): TaskDto;
  startTask(taskId: TaskId): WorkstreamDto;
  listFlows(): FlowDto[];
  listWorkstreams(filter: { readonly active: boolean }): WorkstreamDto[];
  cancelWorkstream(id: WorkstreamId): Promise<WorkstreamDto>;
  retryWorkstream(id: WorkstreamId): WorkstreamDto;
  listInbox(filter: { readonly states: readonly InboxState[] | null }): InboxItemDto[];
  answerInbox(id: InboxItemId, answer: InboxAnswer): InboxItemDto;
  eventsAfter(afterSeq: number, limit: number): DaemonEvent[];
  subscribe(listener: (event: DaemonEvent) => void): () => void;
  systemCheck(): Promise<SystemCheckDto>;
  keepAwake(): KeepAwakeStatus;
  setKeepAwake(mode: KeepAwakeMode): KeepAwakeStatus;
  /** The newest event seq (0 when there are none). */
  eventsHead(): number;
  /** Each server in the project's `.mcp.json` and its verdict; raises an approval card for each one with none. */
  reviewProjectMcp(projectId: ProjectId): McpServerStatusDto[];
  listPersonas(): PersonaDto[];
  createPersona(input: PersonaInput): PersonaDto;
  patchPersona(id: PersonaId, patch: PersonaPatch): PersonaDto;
  listPeople(): PersonDto[];
  createPerson(input: PersonInput): PersonDto;
  createFlow(input: FlowInput): FlowDto;
  patchFlow(id: FlowId, patch: FlowPatch): FlowDto;
  listModelProfiles(): ModelProfileDto[];
  patchModelProfile(id: ModelProfileId, patch: ModelProfilePatch): ModelProfileDto;
  benchmarkStatus(): BenchmarkStatusDto;
  syncBenchmarks(): Promise<BenchmarkStatusDto>;
  /** AA's list as stored locally; the UI shows it only with AA's attribution. */
  listAaModels(): AaModelDto[];
  patchProject(id: ProjectId, patch: ProjectPatch): ProjectDto;
  getTeam(projectId: ProjectId): TeamDto;
  setTeam(projectId: ProjectId, input: TeamInput): TeamDto;
  listRoutingRules(projectId: ProjectId): RoutingRuleDto[];
  setRoutingRules(projectId: ProjectId, input: RoutingRulesInput): RoutingRuleDto[];
  patchTask(id: TaskId, patch: TaskPatch): TaskDto;
  /** What starting the task would run; throws InvalidError when no flow or profile fits. */
  stepPlan(taskId: TaskId): StepPlanDto;
}
