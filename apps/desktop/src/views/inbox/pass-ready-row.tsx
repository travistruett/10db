import { PassCheckDetail, type InboxItemDto, type TaskId } from '@10db/contracts';
import {
  Anchor,
  Badge,
  Button,
  Group,
  List,
  Paper,
  Stack,
  Text,
  UnstyledButton,
} from '@mantine/core';
import { useNavigate } from '@tanstack/react-router';
import { useSignOff } from '../../daemon/pass-close-queries';
import { ProjectLabel } from '../../shell/project-label';
import { useSelectedProject } from '../../shell/selected-project';
import { SELECTED_CARD_ATTRIBUTE } from './use-inbox-keys';

export interface PassReadyRowProps {
  /** The pass's Ready items, one per page, oldest first. */
  readonly items: readonly [InboxItemDto, ...InboxItemDto[]];
  readonly selected: boolean;
  readonly onSelect: () => void;
}

/** "Workbench: 3 pages ready". */
export function passReadyTitle(count: number): string {
  return `Workbench: ${String(count)} ${count === 1 ? 'page' : 'pages'} ready`;
}

/** Opens the Workbench in the pass's project, at one of its pages when given. */
type OpenWorkbench = (taskId?: TaskId) => void;

/** One Ready page of the row: its title, which opens it in the Workbench, and Sign Off for it. */
function ReadyPage({
  item,
  onOpen,
}: {
  readonly item: InboxItemDto;
  readonly onOpen: OpenWorkbench;
}) {
  const signOff = useSignOff();
  const detail = PassCheckDetail.safeParse(item.detail);
  return (
    <List.Item>
      <Group gap="sm" wrap="nowrap">
        {/* Item titles are written by the daemon from task titles: text only. */}
        <Anchor
          component="button"
          type="button"
          size="sm"
          ta="left"
          style={{ flex: 1, minWidth: 0 }}
          onClick={() => {
            onOpen(detail.success ? detail.data.taskId : undefined);
          }}
        >
          {item.title}
        </Anchor>
        {signOff.error ? (
          <Text size="xs" c="red">
            {signOff.error.message}
          </Text>
        ) : null}
        {detail.success ? (
          <Button
            variant="default"
            size="xs"
            loading={signOff.isPending}
            onClick={() => {
              signOff.mutate({ passId: detail.data.passId, taskId: detail.data.taskId });
            }}
          >
            Sign Off
          </Button>
        ) : null}
      </Group>
    </List.Item>
  );
}

/**
 * A Workbench pass's Ready pages as one row (spec §4.1, §6.1): it opens the Workbench, and names each
 * page, which opens it there, each with Sign Off. A page is never approved or sent back; the builder
 * looks at it and writes again, or signs it off.
 */
export function PassReadyRow({ items, selected, onSelect }: PassReadyRowProps) {
  const [first] = items;
  const navigate = useNavigate();
  const { select } = useSelectedProject();
  // The Workbench shows the selected project's pass, so the pass's project is selected first.
  const open: OpenWorkbench = (taskId) => {
    select(first.projectId);
    void navigate({ to: '/workbench', search: taskId === undefined ? {} : { task: taskId } });
  };
  const header = (
    <Group gap="sm" wrap="nowrap">
      {/* Every card waits on the builder: yellow, never the red of a failure. */}
      <Badge size="sm" variant="light" color="yellow" style={{ flexShrink: 0 }}>
        Workbench
      </Badge>
      <ProjectLabel projectId={first.projectId} />
      <Text size="sm" fw={selected ? 600 : undefined} lineClamp={1} style={{ minWidth: 0 }}>
        {passReadyTitle(items.length)}
      </Text>
    </Group>
  );
  if (!selected)
    return (
      <UnstyledButton
        onClick={onSelect}
        p="sm"
        style={{
          borderRadius: 'var(--mantine-radius-md)',
          border: '1px solid var(--mantine-color-default-border)',
        }}
      >
        {header}
      </UnstyledButton>
    );
  return (
    <Paper withBorder p="md" shadow="xs" {...{ [SELECTED_CARD_ATTRIBUTE]: true }}>
      <Stack gap="sm">
        {header}
        <List size="sm" spacing={4}>
          {items.map((item) => (
            <ReadyPage key={item.id} item={item} onOpen={open} />
          ))}
        </List>
        <Group>
          <Button
            variant="default"
            size="xs"
            onClick={() => {
              open();
            }}
          >
            Open Workbench
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}
