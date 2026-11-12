import type { InboxItemDto, PassViewDto, ProjectViewDto, TaskId } from '@10db/contracts';

/**
 * What the Workbench view hands the pass's workspace (the queue and the selected page's thread). The
 * view owns the route's `?task=` and so the selection.
 */
export interface PassWorkspaceProps {
  readonly view: PassViewDto;
  /** The open Inbox items: a page's question or permission is one that targets its run. */
  readonly inbox: readonly InboxItemDto[];
  readonly project: ProjectViewDto;
  /** The selected page's task; null when none is. */
  readonly selected: TaskId | null;
  readonly onSelect: (taskId: TaskId) => void;
}
