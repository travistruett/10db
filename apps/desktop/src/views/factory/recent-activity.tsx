import type { ProjectId } from '@10db/contracts';
import { Alert, Box, Button, Stack, Text, Title, UnstyledButton } from '@mantine/core';
import { useId, useState } from 'react';
import { useActivityRows } from '../../daemon/activity-queries';
import { useNow } from '../../shell/relative';
import { SurfaceDrawer } from '../../shell/surface-drawer';
import { ActivityContent } from './activity-content';
import { activityRowOf, ActivityRowItem, type ActivityListRow } from './activity-row-item';

/** How many notices show at first, and how many more each Show More adds. */
const FIRST_SHOWN = 8;
const MORE_SHOWN = 20;

/**
 * Recent activity: the notices that tell the builder something and ask nothing (a deleted empty branch, work
 * skipped while they were away), newest first, for the project the Factory shows or every project. A row opens
 * its notice in a drawer. It is a log, never counted and never answered.
 */
export function RecentActivity({ project }: { readonly project: ProjectId | null }) {
  const now = useNow();
  const rows = useActivityRows(project === null ? {} : { project });
  const [limit, setLimit] = useState(FIRST_SHOWN);
  const [open, setOpen] = useState<ActivityListRow | null>(null);
  const headingId = useId();
  const all = rows.rows.map(activityRowOf);
  const shown = all.slice(0, limit);
  const more = all.length > limit || rows.hasMore;
  return (
    <Box component="section" aria-labelledby={headingId}>
      <Stack gap="xs">
        <Title order={3} id={headingId}>
          Recent activity
        </Title>
        {rows.error ? (
          <Alert color="red" title="Couldn't load activity">
            {rows.error.message}
          </Alert>
        ) : null}
        {!rows.isPending && all.length === 0 ? (
          <Text size="sm" c="dimmed">
            Nothing has happened yet.
          </Text>
        ) : null}
        {shown.length > 0 ? (
          <Box
            component="ul"
            m={0}
            p={0}
            style={{
              listStyle: 'none',
              borderTop: '1px solid var(--mantine-color-default-border)',
            }}
          >
            {shown.map((row) => (
              <li
                key={row.key}
                style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}
              >
                <UnstyledButton
                  w="100%"
                  px="sm"
                  aria-label={row.row.line}
                  onClick={() => {
                    setOpen(row);
                  }}
                  style={{ borderRadius: 'var(--mantine-radius-md)' }}
                >
                  <ActivityRowItem row={row} now={now} />
                </UnstyledButton>
              </li>
            ))}
          </Box>
        ) : null}
        {more ? (
          <Box>
            <Button
              variant="subtle"
              size="xs"
              loading={rows.loadingMore}
              onClick={() => {
                const next = limit + MORE_SHOWN;
                setLimit(next);
                if (next > all.length) rows.loadMore();
              }}
            >
              Show More
            </Button>
          </Box>
        ) : null}
        {rows.moreError ? (
          <Text size="xs" c="red">
            {`Couldn't load more: ${rows.moreError.message}`}
          </Text>
        ) : null}
      </Stack>
      <SurfaceDrawer
        opened={open !== null}
        onClose={() => {
          setOpen(null);
        }}
        label="Notice"
      >
        {open === null ? null : <ActivityContent key={open.key} row={open.row} />}
      </SurfaceDrawer>
    </Box>
  );
}
