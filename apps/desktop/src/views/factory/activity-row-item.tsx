import type { ActivityRow } from '@10db/contracts';
import { Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { ProjectLabel } from '../../shell/project-label';
import { shortAgo } from './short-ago';
import { Lines } from '../inbox/inbox-row-item';
import { decidedByText, undoText } from './activity-decision';

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
 * The two lines of an Activity row: an orange mark for a warning (as a task's notices are), the line,
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
      mark={
        notice.tone === 'warning' ? (
          <IconAlertTriangle
            size={14}
            stroke={1.75}
            color="var(--mantine-color-orange-text)"
            aria-label="Warning"
            style={{ flexShrink: 0 }}
          />
        ) : null
      }
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
            {notice.decision === undefined
              ? firstLine(notice.body)
              : `${decidedByText(notice.decision)} · ${undoText({ ...notice, decision: notice.decision }) ?? 'Can be undone'}`}
          </Text>
        </>
      }
      failure={null}
    />
  );
}
