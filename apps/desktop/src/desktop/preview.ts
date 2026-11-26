import {
  PickArrived,
  PickRemoved,
  PreviewShowComposer,
  type ProjectId,
  type TaskId,
} from '@10db/contracts';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { isTauri } from './tauri';

// Pick on Page spec §2, §5: the main window's side of the Preview window. It opens the preview with the
// picker it bundles, and takes what the shell emits from it; each payload is parsed here again, since it
// began in a page running agent-written code.

export interface PreviewTarget {
  readonly projectId: ProjectId;
  readonly appUrl: string;
  readonly route: string;
  readonly taskId: TaskId;
  readonly pageLabel: string;
  readonly repoPath: string;
}

/** Whether this window can open a Preview: only the desktop app has one. */
export const previewAvailable = (): boolean => isTauri();

/** Opens, or reuses, the project's Preview on the page's route; its picks go to that page's draft. */
export async function openPreview(target: PreviewTarget): Promise<void> {
  // Bundled on first use, so a window that never opens a preview never builds it.
  const { default: picker } = await import('virtual:picker-source');
  await invoke('open_preview', { ...target, picker });
}

/** Drops picks from the project's Preview, saying `notice` there when there is one. */
export async function dropPreviewPicks(
  projectId: ProjectId,
  pickIds: readonly string[],
  notice: string | null = null,
): Promise<void> {
  if (!isTauri() || pickIds.length === 0) return;
  await invoke('drop_preview_picks', { projectId, pickIds, notice });
}

/** Flashes a pick's badge in the project's Preview. */
export async function flashPreviewPick(projectId: ProjectId, pickId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke('flash_preview_pick', { projectId, pickId });
}

export interface PreviewHandlers {
  readonly picked: (arrived: PickArrived) => void;
  readonly removed: (removed: PickRemoved) => void;
  readonly showComposer: (shown: PreviewShowComposer) => void;
}

/** Listens for what the shell emits from Previews; a payload that doesn't parse is dropped. */
export async function listenToPreviews(handlers: PreviewHandlers): Promise<UnlistenFn> {
  const off = await Promise.all([
    listen<unknown>('preview-pick', (event) => {
      const parsed = PickArrived.safeParse(event.payload);
      if (parsed.success) handlers.picked(parsed.data);
    }),
    listen<unknown>('preview-pick-removed', (event) => {
      const parsed = PickRemoved.safeParse(event.payload);
      if (parsed.success) handlers.removed(parsed.data);
    }),
    listen<unknown>('preview-show-composer', (event) => {
      const parsed = PreviewShowComposer.safeParse(event.payload);
      if (parsed.success) handlers.showComposer(parsed.data);
    }),
  ]);
  return () => {
    for (const unlisten of off) unlisten();
  };
}
