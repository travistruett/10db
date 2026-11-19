import type { ActivityRow } from '@10db/contracts';
import { Text } from '@mantine/core';
import { IconAlertTriangle, IconInfoCircle } from '@tabler/icons-react';
import { ProjectLabel } from '../../shell/project-label';
import { shortAgo } from './short-ago';
import { Lines } from '../inbox/inbox-row-item';

/** A row of Activity; `key` names its group, so the open notice stays the same group as repeats join it. */
export interface ActivityListRow {
  readonly key: string;
  readonly row: ActivityRow;
}

/**
 * A group is keyed by what joins it and its oldest notice's time, which a repeat never changes: the
 * newest notice's seq would re-key the selected row and send the selection elsewhere.
 */
export function activityRowOf(row: ActivityRow): ActivityListRow {
  return {
    key: `notice:${row.key}|${row.projectId ?? ''}|${row.taskId ?? ''}|${row.firstAt}`,
    row,
  };
}

const firstLine = (text: string): string => text.split('\n')[0] ?? '';

/**
 * The two lines of an Activity row: a notice's mark (orange for a warning, as a task's notices are), the line,
 * `×n` when grouped and how long ago the newest happened, then the project and the body's first line.
 */
export function ActivityRowItem({
  row,
  now,
}: {
  readonly row: ActivityListRow;
  readonly now: number;
}) {
  const { row: notice } = row;
  return (
    <Lines
      icon={notice.tone === 'warning' ? IconAlertTriangle : IconInfoCircle}
      kind={notice.tone === 'warning' ? 'Warning' : 'Notice'}
      iconColor={
        notice.tone === 'warning'
          ? 'var(--mantine-color-orange-text)'
          : 'var(--mantine-color-dimmed)'
      }
      tone="quiet"
      title={notice.line}
      count={notice.count}
      age={shortAgo(notice.at, now)}
      second={
        <>
          {notice.projectId === null ? (
            <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
              10db
            </Text>
          ) : (
            <ProjectLabel projectId={notice.projectId} />
          )}
          <Text fz={12} c="dimmed" truncate style={{ minWidth: 0 }}>
            {firstLine(notice.body)}
          </Text>
        </>
      }
      failure={null}
    />
  );
}
