import { ACTIVITY_GROUP_WINDOW_MS, type ActivityRow, type NoticePostedData } from '@10db/contracts';

export interface PostedNotice {
  readonly seq: number;
  readonly at: string;
  readonly data: NoticePostedData;
}

interface OpenRow {
  row: ActivityRow;
  /** The newest notice's time in ms: the window is measured from it. */
  newestMs: number;
}

/**
 * Folds notices, newest first, into Activity rows: a notice joins the open row with the same key,
 * project and task when it is within the window of that row's newest notice. The walk stops before
 * a notice that would start a row past `pageSize`.
 */
export function groupNotices(
  notices: readonly PostedNotice[],
  pageSize: number,
): { readonly rows: ActivityRow[]; readonly consumed: number; readonly full: boolean } {
  const open: OpenRow[] = [];
  let consumed = 0;
  for (const notice of notices) {
    const ms = Date.parse(notice.at);
    const target = open.find(
      (o) =>
        o.row.key === notice.data.key &&
        o.row.projectId === notice.data.projectId &&
        o.row.taskId === notice.data.taskId &&
        o.newestMs - ms <= ACTIVITY_GROUP_WINDOW_MS,
    );
    if (target) {
      target.row = { ...target.row, count: target.row.count + 1, firstAt: notice.at };
    } else {
      if (open.length === pageSize) return { rows: open.map((o) => o.row), consumed, full: true };
      open.push({
        row: { ...notice.data, seq: notice.seq, at: notice.at, firstAt: notice.at, count: 1 },
        newestMs: ms,
      });
    }
    consumed += 1;
  }
  return { rows: open.map((o) => o.row), consumed, full: false };
}
