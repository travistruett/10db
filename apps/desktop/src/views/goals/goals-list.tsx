import { GoalStatus, type GoalId, type GoalSummaryDto, type ProjectViewDto } from '@10db/contracts';
import {
  Anchor,
  Badge,
  Box,
  Button,
  Container,
  HoverCard,
  Paper,
  Stack,
  Text,
  UnstyledButton,
} from '@mantine/core';
import { IconChevronDown, IconChevronRight, IconPlus, IconTarget } from '@tabler/icons-react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { useShapeOf } from '../../daemon/shape-queries';
import { ContentWidth } from '../../shell/content-width';
import { EmptyState } from '../../shell/empty-state';
import { PageIntro } from '../../shell/page-intro';
import { ScopeBadge } from '../../shell/scope-badge';
import { TitleRow } from '../../shell/title-row';
import { GOAL_STATUS_LOOK } from '../board/goal-status';
import { goalBar } from '../factory/factory-summary';
import { goalStatusWord, groupGoals } from '../factory/goal-status';
import { shortAgo } from '../factory/short-ago';
import { StackedBar } from '../factory/stacked-bar';
import { StatusDot } from '../factory/status-dot';
import { useNewPlan } from '../sessions/start-fresh-tab';
import { NextAction, nextStep } from './goal-next-step';
import classes from './goals-list.module.css';

/** The list's groups: what needs the builder, what moves, what hasn't begun. Done folds away. */
const GROUPS: readonly { readonly title: string; readonly statuses: readonly GoalStatus[] }[] = [
  {
    title: 'Needs you',
    statuses: [GoalStatus.Failed, GoalStatus.WaitingOnYou],
  },
  {
    title: 'In progress',
    statuses: [
      GoalStatus.WaitingOnSomeone,
      GoalStatus.Paused,
      GoalStatus.Running,
      GoalStatus.Queued,
      GoalStatus.Shipping,
      GoalStatus.Idle,
    ],
  },
  { title: 'Not started', statuses: [GoalStatus.NotStarted] },
];

const ACTION_LABEL: Readonly<Record<NextAction, string>> = {
  start: 'Start Ready Tasks',
  answer: 'Answer',
  retry: 'Retry',
  merge: 'Open Board',
};

export interface GoalsListProps {
  readonly project: ProjectViewDto;
  readonly goals: readonly GoalSummaryDto[];
  /** Each goal's tasks that are ready to start, by goal id. */
  readonly ready: ReadonlyMap<GoalId, number>;
  readonly onStart: (goal: GoalSummaryDto) => void;
}

/**
 * The project's goals as one table, a line each on shared columns (status, title, progress, state, next
 * step, action, last change) under group headings, so the eye runs down any column. The objective and
 * the session it was planned in are in the title's hover card.
 */
export function GoalsList({ project, goals, ready, onStart }: GoalsListProps) {
  const newPlan = useNewPlan();
  const [doneShown, setDoneShown] = useState(false);
  const { open, done } = groupGoals(goals);
  const DoneChevron = doneShown ? IconChevronDown : IconChevronRight;
  const row = (g: GoalSummaryDto) => (
    <GoalLine
      key={g.goal.id}
      summary={g}
      ready={ready.get(g.goal.id) ?? 0}
      onStart={() => {
        onStart(g);
      }}
    />
  );
  return (
    <Container size={ContentWidth.Page} w="100%">
      <TitleRow title="Goals" meta={<ScopeBadge name={project.name} />} />
      <Stack gap="lg" pb="xl">
        <PageIntro
          description="Outcomes 10db works toward across many tasks. Plan one in a session; follow it here."
          actions={
            <Button size="sm" leftSection={<IconPlus size={16} />} onClick={newPlan}>
              New Goal
            </Button>
          }
        />
        {goals.length === 0 ? (
          <EmptyState
            icon={IconTarget}
            title="No goals yet"
            action={{ label: 'New Goal', icon: IconPlus, onClick: newPlan }}
          >
            A goal is an outcome 10db works toward across many tasks. Plan one in a session; Accept
            makes it a goal.
          </EmptyState>
        ) : (
          <Paper variant="raised" radius="md" style={{ overflow: 'hidden' }}>
            <Box className={classes['head']}>
              <span />
              <span>Goal</span>
              <span>Progress</span>
              <span />
              <span>Status</span>
              <span>Next step</span>
              <span />
              <Text size="xs" c="dimmed" ta="right">
                Updated
              </Text>
            </Box>
            {GROUPS.map((group) => {
              const inGroup = open.filter((g) => group.statuses.includes(g.digest.status));
              if (inGroup.length === 0) return null;
              return (
                <Box key={group.title}>
                  <GroupHead title={group.title} count={inGroup.length} />
                  {inGroup.map(row)}
                </Box>
              );
            })}
            {done.length > 0 ? (
              <Box>
                <UnstyledButton
                  w="100%"
                  aria-expanded={doneShown}
                  onClick={() => {
                    setDoneShown(!doneShown);
                  }}
                >
                  <GroupHead
                    title="Done"
                    count={done.length}
                    icon={<DoneChevron size={14} stroke={1.5} aria-hidden />}
                  />
                </UnstyledButton>
                {doneShown ? done.map(row) : null}
              </Box>
            ) : null}
          </Paper>
        )}
      </Stack>
    </Container>
  );
}

function GroupHead({
  title,
  count,
  icon,
}: {
  readonly title: string;
  readonly count: number;
  readonly icon?: ReactNode;
}) {
  return (
    <Box className={classes['group']}>
      {icon}
      <Text size="xs" fw={600} c="bright">
        {title}
      </Text>
      <Text size="xs" c="dimmed">
        {count}
      </Text>
    </Box>
  );
}

function GoalLine({
  summary,
  ready,
  onStart,
}: {
  readonly summary: GoalSummaryDto;
  readonly ready: number;
  readonly onStart: () => void;
}) {
  const plannedIn = useShapeOf({ goalId: summary.goal.id }).data?.title ?? null;
  const navigate = useNavigate();
  const { goal, digest } = summary;
  const look = GOAL_STATUS_LOOK[digest.status];
  const step = nextStep(digest, ready);
  const { merged, total } = digest.progress;
  return (
    <Box
      className={classes['row']}
      style={{ cursor: 'pointer' }}
      onClick={() => {
        void navigate({ to: '/goals', search: { goal: goal.id } });
      }}
    >
      <StatusDot color={look.color} />
      <HoverCard position="bottom-start" openDelay={400} shadow="md" width={420}>
        <HoverCard.Target>
          <Box style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <Anchor
              renderRoot={(props) => <Link {...props} to="/goals" search={{ goal: goal.id }} />}
              size="sm"
              fw={600}
              c="bright"
              underline="never"
              truncate
              onClick={(e) => {
                e.stopPropagation();
              }}
            >
              {goal.title}
            </Anchor>
            {summary.newItems > 0 ? (
              <Badge size="xs" variant="light" color="gray" style={{ flex: 'none' }}>
                {`${String(summary.newItems)} new`}
              </Badge>
            ) : null}
          </Box>
        </HoverCard.Target>
        <HoverCard.Dropdown>
          <Stack gap={6}>
            <Text size="sm">{goal.objective}</Text>
            {plannedIn === null ? null : (
              <Text size="xs" c="dimmed">{`Planned in ${plannedIn}`}</Text>
            )}
          </Stack>
        </HoverCard.Dropdown>
      </HoverCard>
      <StackedBar counts={goalBar(digest.progress)} size="sm" tips={false} />
      <Text size="xs" c="dimmed" ta="right" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {`${String(merged)}/${String(total)}`}
      </Text>
      <Text
        size="sm"
        fw={500}
        truncate
        {...(look.color === 'gray' ? { c: 'dimmed' } : { c: look.color })}
      >
        {goalStatusWord(digest)}
      </Text>
      <Text size="sm" c="dimmed" truncate>
        {step.short}
      </Text>
      <Box
        style={{ justifySelf: 'end' }}
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <NextButton goalId={goal.id} action={step.action} onStart={onStart} />
      </Box>
      <Text size="xs" c="dimmed" ta="right">
        {shortAgo(goal.updatedAt).replace(' ago', '')}
      </Text>
    </Box>
  );
}

/**
 * The goal's one action on its line: Start Ready Tasks opens the start sheet, Answer the Inbox, Open Board its
 * tasks there; a failed goal opens its page, where each failed run has its Retry.
 */
function NextButton({
  goalId,
  action,
  onStart,
}: {
  readonly goalId: GoalId;
  readonly action: NextAction | null;
  readonly onStart: () => void;
}): ReactNode {
  const navigate = useNavigate();
  if (action === null) return null;
  const label = ACTION_LABEL[action];
  const go = (): void => {
    switch (action) {
      case NextAction.Start:
        onStart();
        return;
      case NextAction.Answer:
        void navigate({ to: '/inbox' });
        return;
      case NextAction.Merge:
        void navigate({ to: '/board', search: { goal: goalId } });
        return;
      case NextAction.Retry:
        void navigate({ to: '/goals', search: { goal: goalId } });
        return;
    }
  };
  return (
    <Button
      size="compact-xs"
      variant={action === NextAction.Answer ? 'light' : 'default'}
      {...(action === NextAction.Answer ? { color: 'yellow' } : {})}
      onClick={go}
    >
      {label}
    </Button>
  );
}
