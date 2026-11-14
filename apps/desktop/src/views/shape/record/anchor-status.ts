import {
  AnchorResult,
  type AnchorCheckDto,
  type PlanAnchor,
  type PlanEvidenceTaskChecks,
  type TaskId,
} from '@10db/contracts';
import dayjs from 'dayjs';

// How an anchor's check reads: a word and a color, the same in Evidence and the task drawer. Only a
// check that found the excerpt at its line is Current; nothing else is ever green.

export interface AnchorStatus {
  readonly label: string;
  readonly color: 'green' | 'yellow' | 'red' | 'gray';
  /** Where and when the check read: its line or note, its commit and its day, shown beside the word. */
  readonly detail: string | null;
}

/** What one check found, in words. */
export function checkStatus(check: AnchorCheckDto | undefined, anchor: PlanAnchor): AnchorStatus {
  if (anchor.kind === 'url')
    return {
      label: `Read ${dayjs(anchor.readAt).format('D MMM YYYY')}`,
      color: 'gray',
      detail: null,
    };
  if (check === undefined) return { label: 'Not checked', color: 'gray', detail: null };
  return resultStatus(check);
}

/** What one check found, in words, without its anchor: a page's check says it was not fetched. */
export function resultStatus(check: AnchorCheckDto): AnchorStatus {
  const detail = (what: string | null): string =>
    [
      what,
      check.checkedCommit === null ? null : `at ${check.checkedCommit.slice(0, 8)}`,
      dayjs(check.at).format('D MMM YYYY'),
    ]
      .filter((part) => part !== null)
      .join(' · ');
  switch (check.result) {
    case AnchorResult.Current:
      return { label: 'Current', color: 'green', detail: detail(`line ${String(check.line)}`) };
    case AnchorResult.Moved:
      return { label: 'Moved', color: 'yellow', detail: detail(`now line ${String(check.line)}`) };
    case AnchorResult.Changed:
      return { label: 'Changed', color: 'red', detail: detail('not found') };
    case AnchorResult.Unchecked:
      return { label: 'Not checked', color: 'gray', detail: detail(check.note) };
    case AnchorResult.Url:
      return { label: 'Page, not fetched', color: 'gray', detail: null };
  }
}

/** Where an anchor points: `path:line` for code, the host for a page. */
export function anchorPlace(anchor: PlanAnchor): string {
  if (anchor.kind === 'code') return `${anchor.path}:${String(anchor.line)}`;
  return URL.parse(anchor.url)?.host ?? anchor.url;
}

/** Each task's newest check of one anchor; one Not checked when no task has checked it. */
export function anchorStatuses(
  anchor: PlanAnchor,
  index: number,
  checks: readonly PlanEvidenceTaskChecks[],
): {
  readonly taskId: TaskId | null;
  /** The task whose check it is; null when no task has checked it. */
  readonly title: string | null;
  readonly status: AnchorStatus;
}[] {
  const found = checks.flatMap(({ taskId, title, results }) => {
    const result = results.find((r) => r.anchorIndex === index);
    return result === undefined ? [] : [{ taskId, title, status: checkStatus(result, anchor) }];
  });
  return found.length > 0
    ? found
    : [{ taskId: null, title: null, status: checkStatus(undefined, anchor) }];
}
