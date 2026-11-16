import {
  ConflictError,
  EventType,
  type ChatId,
  type PendingOpenDto,
  type ProjectId,
} from '@10db/contracts';
import type { StateStore } from '../events';

/** An open of a pass that waits for chats' turns to end, kept in memory: a restart drops it. */
export interface PendingOpen extends PendingOpenDto {
  /** The chat whose Do It asked for it, or null for Start Pass. */
  readonly chatId: ChatId | null;
}

/** The pass opens waiting for Your folder: at most one per project. */
export interface PendingOpens {
  /** Registers the project's wait and answers the signal its open waits on; refused while one exists. */
  begin(projectId: ProjectId, open: PendingOpen): AbortSignal;
  /** Forgets the wait `signal` belongs to once its open has finished or been refused; a newer wait stays. Idempotent. */
  end(projectId: ProjectId, signal: AbortSignal): void;
  /** The wait, as the folder view shows it. */
  view(projectId: ProjectId): PendingOpenDto | null;
  /** The wait with the chat that asked for it. */
  get(projectId: ProjectId): PendingOpen | null;
  /** Aborts the project's wait; whether there was one. */
  cancel(projectId: ProjectId): boolean;
  /** Aborts every wait, so an update's drain never waits for one; answers each project's wait that was cancelled. */
  cancelAll(): { readonly projectId: ProjectId; readonly name: string }[];
  /** Refuses with the wait named when the project has one: nothing queues behind an open that waits. */
  refuseWhilePending(projectId: ProjectId): void;
}

export function createPendingOpens(deps: { readonly state: StateStore }): PendingOpens {
  const waits = new Map<ProjectId, { open: PendingOpen; controller: AbortController }>();
  const changed = (projectId: ProjectId): void => {
    deps.state.write((ctx) => {
      ctx.emit({
        type: EventType.FolderHoldChanged,
        entityType: 'project',
        entityId: projectId,
        data: {},
      });
    });
  };
  const get = (projectId: ProjectId): PendingOpen | null => waits.get(projectId)?.open ?? null;
  return {
    begin(projectId, open) {
      const existing = get(projectId);
      if (existing)
        throw new ConflictError(`A pass is already waiting to open: ‘${existing.name}’`);
      const controller = new AbortController();
      waits.set(projectId, { open, controller });
      changed(projectId);
      return controller.signal;
    },
    end(projectId, signal) {
      if (waits.get(projectId)?.controller.signal !== signal) return;
      waits.delete(projectId);
      changed(projectId);
    },
    get,
    view(projectId) {
      const open = get(projectId);
      return open === null ? null : { name: open.name, waitsFor: open.waitsFor };
    },
    cancel(projectId) {
      const wait = waits.get(projectId);
      if (!wait) return false;
      wait.controller.abort();
      // Gone at once, not when its open notices: nothing then refuses a new open for a record that no longer waits.
      waits.delete(projectId);
      changed(projectId);
      return true;
    },
    cancelAll() {
      const cancelled = [...waits].map(([projectId, wait]) => ({
        projectId,
        name: wait.open.name,
      }));
      for (const { projectId } of cancelled) this.cancel(projectId);
      return cancelled;
    },
    refuseWhilePending(projectId) {
      const existing = get(projectId);
      if (existing)
        throw new ConflictError(`A pass is already waiting to open: ‘${existing.name}’`);
    },
  };
}
