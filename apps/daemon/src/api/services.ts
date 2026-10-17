import type {
  DaemonEvent,
  InboxAnswer,
  InboxItemDto,
  InboxItemId,
  InboxState,
  KeepAwakeMode,
  KeepAwakeStatus,
  McpServerStatusDto,
  ProjectDto,
  ProjectId,
  ProjectInput,
  SystemCheckDto,
  TaskDto,
  TaskId,
  TaskInput,
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
}
