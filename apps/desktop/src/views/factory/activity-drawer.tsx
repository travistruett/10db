import type { ProjectId } from '@10db/contracts';
import {
  ActionIcon,
  Alert,
  Anchor,
  Box,
  Button,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { IconHistory } from '@tabler/icons-react';
import { useState } from 'react';
import { useActivityRows } from '../../daemon/activity-queries';
import { useNow } from '../../shell/relative';
import { SurfaceDrawer } from '../../shell/surface-drawer';
import { ActivityContent } from './activity-content';
import { activityRowOf, ActivityRowItem, type ActivityListRow } from './activity-row-item';

/** How many notices show at first, and how many more each Show More adds. */
const FIRST_SHOWN = 20;
const MORE_SHOWN = 20;

/**
 * The Factory's Activity button and its drawer: the notices that tell the builder something and ask nothing (a
 * deleted empty branch, work skipped while they were away), newest first, for the project the Factory shows or
 * every project. Most of the time none of it matters, so it waits behind the button rather than on the page. A
 * row opens its notice in the drawer, with a way back to the list. It is a log, never counted and never answered.
 */
export function ActivityButton({ project }: { readonly project: ProjectId | null }) {
  const [opened, setOpened] = useState(false);
  return (
    <>
      <Tooltip label="Activity" position="bottom">
        <ActionIcon
          variant={opened ? 'light' : 'subtle'}
          color="gray"
          aria-label="Activity"
          aria-expanded={opened}
          onClick={() => {
            setOpened((was) => !was);
          }}
        >
          <IconHistory size={16} stroke={1.6} />
        </ActionIcon>
      </Tooltip>
      <SurfaceDrawer
        opened={opened}
        onClose={() => {
          setOpened(false);
        }}
        label="Activity"
      >
        {opened ? <ActivityList project={project} /> : null}
      </SurfaceDrawer>
    </>
  );
}

function ActivityList({ project }: { readonly project: ProjectId | null }) {
  const now = useNow();
  const rows = useActivityRows(project === null ? {} : { project });
  const [limit, setLimit] = useState(FIRST_SHOWN);
  const [open, setOpen] = useState<ActivityListRow | null>(null);
  if (open !== null)
    return (
      <Stack gap="md">
        <Anchor
          component="button"
          size="sm"
          onClick={() => {
            setOpen(null);
          }}
          style={{ alignSelf: 'flex-start' }}
        >
          All Activity
        </Anchor>
        <ActivityContent key={open.key} row={open.row} />
      </Stack>
    );
  const all = rows.rows.map(activityRowOf);
  const shown = all.slice(0, limit);
  const more = all.length > limit || rows.hasMore;
  return (
    <Stack gap="xs">
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
          style={{ listStyle: 'none', borderTop: '1px solid var(--mantine-color-default-border)' }}
        >
          {shown.map((row) => (
            <li
              key={row.key}
              style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}
            >
              <UnstyledButton
                w="100%"
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
  );
}
