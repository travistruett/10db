import type { ProjectId } from '@10db/contracts';
import {
  ActionIcon,
  Alert,
  Anchor,
  Box,
  Button,
  Stack,
  Switch,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconHistory, IconSearch } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { useActivityRows } from '../../daemon/activity-queries';
import { useNow } from '../../shell/relative';
import { SurfaceDrawer } from '../../shell/surface-drawer';
import { ActivityContent } from './activity-content';
import { activityRowOf, ActivityRowItem } from './activity-row-item';
import classes from './activity-drawer.module.css';
import { ControlSize } from '../../shell/control-size';

/** How many notices show at first, and how many more each Show More adds. */
const FIRST_SHOWN = 20;
const MORE_SHOWN = 20;

/**
 * The Factory's Activity button and its drawer: the notices that tell the builder something and ask nothing (a
 * deleted empty branch, work skipped while they were away), newest first, for the project the Factory shows or
 * every project. Most of the time none of it matters, so it waits behind the button rather than on the page. A
 * row opens its notice in the drawer, with a way back to the list, and a search narrows the list. It is a log, never counted and never answered.
 */
export function ActivityButton({ project }: { readonly project: ProjectId | null }) {
  const [opened, setOpened] = useState(false);
  return (
    <>
      <Tooltip label="Activity" position="bottom">
        <ActionIcon
          size={ControlSize.Toolbar}
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

/** How long the search waits after the last keystroke before it asks again. */
const SEARCH_PAUSE_MS = 250;

function ActivityList({ project }: { readonly project: ProjectId | null }) {
  const now = useNow();
  const [text, setText] = useState('');
  const [typed] = useDebouncedValue(text.trim(), SEARCH_PAUSE_MS);
  const [decidedOnly, setDecidedOnly] = useState(false);
  const rows = useActivityRows({
    ...(project === null ? {} : { project }),
    ...(typed === '' ? {} : { q: typed }),
    ...(decidedOnly ? { decided: 'true' as const } : {}),
  });
  const [limit, setLimit] = useState(FIRST_SHOWN);
  // The open notice is looked up by key on each render, so a repeat that joins it shows at once.
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [backTo, setBackTo] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const all = rows.rows.map(activityRowOf);
  const open = openKey === null ? null : (all.find((row) => row.key === openKey) ?? null);
  // Focus follows the switch between the list and a notice, so it never falls out of the drawer (where Esc
  // closes it): to the way back when a notice opens, and to the row it came from on the way back. It runs only
  // on the switch (the keys are strings), never on a render that keeps the same view.
  useEffect(() => {
    const target =
      openKey !== null
        ? root.current?.querySelector<HTMLElement>('[data-activity-back]')
        : backTo === null
          ? null
          : root.current?.querySelector<HTMLElement>(`[data-activity-key="${CSS.escape(backTo)}"]`);
    target?.focus();
  }, [openKey, backTo]);
  if (open !== null)
    return (
      <Stack gap="md" ref={root}>
        <Anchor
          component="button"
          size="sm"
          data-activity-back
          onClick={() => {
            setBackTo(open.key);
            setOpenKey(null);
          }}
          style={{ alignSelf: 'flex-start' }}
        >
          All Activity
        </Anchor>
        <ActivityContent key={open.key} row={open.row} />
      </Stack>
    );
  const shown = all.slice(0, limit);
  const more = all.length > limit || rows.hasMore;
  return (
    <Stack gap="sm" ref={root}>
      <TextInput
        size="xs"
        placeholder="Search"
        aria-label="Search activity"
        // The daemon takes at most 200 characters of search.
        maxLength={200}
        leftSection={<IconSearch size={14} stroke={1.6} />}
        value={text}
        onChange={(event) => {
          setText(event.currentTarget.value);
          setLimit(FIRST_SHOWN);
        }}
      />
      <Switch
        size="xs"
        label="Decided For You"
        description="Only what 10db decided, with who decided it"
        checked={decidedOnly}
        onChange={(event) => {
          setDecidedOnly(event.currentTarget.checked);
          setLimit(FIRST_SHOWN);
        }}
      />
      {rows.error ? (
        <Alert color="red" title="Couldn't load activity">
          {rows.error.message}
        </Alert>
      ) : null}
      {!rows.isPending && all.length === 0 ? (
        <Text size="sm" c="dimmed">
          {typed === '' && !decidedOnly
            ? 'Nothing has happened yet.'
            : 'No activity matches the search.'}
        </Text>
      ) : null}
      {shown.length > 0 ? (
        <Box component="ul" className={classes['list']}>
          {shown.map((row) => (
            <li key={row.key} className={classes['item']}>
              <UnstyledButton
                className={classes['row']}
                data-activity-key={row.key}
                onClick={() => {
                  setBackTo(null);
                  setOpenKey(row.key);
                }}
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
              // Never past what has loaded, so a failed page does not make the next one jump.
              const next = Math.min(limit, all.length) + MORE_SHOWN;
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
