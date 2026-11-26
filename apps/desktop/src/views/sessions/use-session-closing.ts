import type { ArchivePreviewDto, ArchiveRequest, ChatId, ProjectId } from '@10db/contracts';
import { useState } from 'react';
import { useArchiveChat, usePatchChat, useUnarchiveChat } from '../../daemon/chat-queries';
import { closedTabs, type ClosedChat } from './closed-tabs';
import type { PanelRow } from './panel-order';

export interface SessionClosing {
  /** Every row, in the order the keys walk. */
  readonly rows: readonly PanelRow[];
  readonly selected: PanelRow | null;
  /** The number of sessions open, which bounds where a reopened one can go. */
  readonly chatCount: number;
  readonly onSelect: (row: PanelRow) => void;
  /** The row left and no other is left to select: the screen opens a fresh tab in its place. */
  readonly onNoneLeft: (gone: PanelRow) => void;
  /** A reopened session is the one to show. */
  readonly onOpenChat: (chatId: ChatId, projectId: ProjectId) => void;
  readonly removeFresh: (id: string) => void;
}

/**
 * Closing, archiving and reopening (sessions spec §6.4). A close stops nothing on the daemon: the row leaves
 * the panel and goes on the closed stack, and a warm session stays warm.
 */
export function useSessionClosing({
  rows,
  selected,
  chatCount,
  onSelect,
  onNoneLeft,
  onOpenChat,
  removeFresh,
}: SessionClosing) {
  const patch = usePatchChat();
  const archive = useArchiveChat();
  const unarchive = useUnarchiveChat();
  const [notice, setNotice] = useState<string | null>(null);
  // What archiving would delete, which the daemon named and the builder has yet to confirm.
  const [confirming, setConfirming] = useState<{
    readonly row: PanelRow & { readonly kind: 'chat' };
    readonly preview: ArchivePreviewDto;
  } | null>(null);

  /** Focus moves to the row below, or above when the closed row was last; with no row left, `onNoneLeft`. */
  const moveFrom = (row: PanelRow): void => {
    if (row.key !== selected?.key) return;
    const index = rows.findIndex((r) => r.key === row.key);
    const next = rows[index + 1] ?? rows[index - 1];
    if (next === undefined) onNoneLeft(row);
    else onSelect(next);
  };

  const remember = (row: PanelRow & { readonly kind: 'chat' }, archived: boolean): void => {
    closedTabs.push({
      chatId: row.chat.id,
      projectId: row.chat.projectId,
      title: row.chat.title,
      position: row.chat.tabPosition ?? 0,
      ...(archived ? { archived: true } : {}),
    });
  };

  const close = (row: PanelRow): void => {
    setNotice(null);
    if (row.kind === 'chat') {
      remember(row, false);
      patch.mutate({ chatId: row.chat.id, tabPosition: null });
    } else removeFresh(row.tab.id);
    moveFrom(row);
  };

  /**
   * Archives a session. Files the worktree holds that are saved nowhere else make the daemon answer with
   * them first; the builder confirms, and the lists sent back are the ones that were shown, so files that
   * appeared since ask again.
   */
  const archiveRow = (row: PanelRow, request?: ArchiveRequest): void => {
    if (row.kind !== 'chat') return;
    setNotice(null);
    archive.mutate(
      { chatId: row.chat.id, ...(request === undefined ? {} : { request }) },
      {
        onSuccess: (answer) => {
          if (!answer.archived) {
            setConfirming({ row, preview: answer.preview });
            return;
          }
          setConfirming(null);
          remember(row, true);
          moveFrom(row);
        },
        onError: (error) => {
          setConfirming(null);
          setNotice(error.message);
        },
      },
    );
  };

  /** Puts a closed session back at the place it held, clamped to the open ones; an archived one comes back first. */
  const reopen = async (entry: ClosedChat): Promise<void> => {
    setNotice(null);
    try {
      if (entry.archived === true) await unarchive.mutateAsync(entry.chatId);
      const chat = await patch.mutateAsync({
        chatId: entry.chatId,
        tabPosition: Math.min(entry.position, chatCount),
      });
      closedTabs.take(entry.chatId);
      onOpenChat(chat.id, chat.projectId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  /** ⌘⇧T: the last closed session; false when none is left. */
  const reopenLast = (): boolean => {
    const entry = closedTabs.list()[0];
    if (entry === undefined) return false;
    void reopen(entry);
    return true;
  };

  return {
    close,
    archiveRow,
    confirming,
    cancelArchive: () => {
      setConfirming(null);
    },
    archiving: archive.isPending,
    reopen,
    reopenLast,
    notice,
    setNotice,
  };
}
