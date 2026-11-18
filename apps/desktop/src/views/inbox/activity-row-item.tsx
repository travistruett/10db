import type { ActivityRow } from '@10db/contracts';
import { Text } from '@mantine/core';
import { ProjectLabel } from '../../shell/project-label';
import { shortAgo } from '../factory/short-ago';
import { Lines } from './inbox-row-item';

/** A row of Activity; `key` is what selection follows, and never collides with a card's id. */
export interface ActivityListRow {
  readonly key: string;
  readonly row: ActivityRow;
}

export function activityRowOf(row: ActivityRow): ActivityListRow {
  return { key: `notice:${String(row.seq)}`, row };
}

const firstLine = (text: string): string => text.split('\n')[0] ?? '';

/**
 * The two lines of an Activity row: a NOTICE tag (orange for a warning, as a task's notices are), the line,
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
      tag="NOTICE"
      tagColor={notice.tone === 'warning' ? 'var(--mantine-color-orange-text)' : 'dimmed'}
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
