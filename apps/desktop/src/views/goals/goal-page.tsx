import {
  CriterionCheck,
  CriterionState,
  type GoalSummaryDto,
  type ProjectViewDto,
} from '@10db/contracts';
import {
  ActionIcon,
  Anchor,
  Badge,
  Box,
  Button,
  Container,
  Grid,
  Group,
  Menu,
  Paper,
  Stack,
  Text,
} from '@mantine/core';
import {
  IconArrowLeft,
  IconCircleCheck,
  IconCircleDashed,
  IconDots,
  IconTrash,
} from '@tabler/icons-react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { Markdown } from '../../conversation/markdown';
import { useShapeOf } from '../../daemon/shape-queries';
import { ContentWidth } from '../../shell/content-width';
import { ScopeBadge } from '../../shell/scope-badge';
import { TitleRow } from '../../shell/title-row';
import { GOAL_STATUS_LOOK } from '../board/goal-status';
import {
  GoalBar,
  GoalFooter,
  NeedsYou,
  SinceYouLooked,
  WaitingOnOthers,
  type OpenedDigest,
} from '../factory/goal-digest';
import { goalStatusWord } from '../factory/goal-status';
import { GoalTasks } from '../factory/goal-tasks';
import { PlannedIn } from '../factory/planned-in';
import type { TaskRow } from '../factory/task-rows';
import { OpenPlanSession } from '../sessions/plan/open-plan-session';
import { useRemoveDraftGoalAction } from '../sessions/plan/remove-draft-goal';
import { NextAction, nextStep } from './goal-next-step';

export interface GoalPageProps {
  readonly project: ProjectViewDto;
  readonly summary: GoalSummaryDto;
  readonly rows: readonly TaskRow[];
  /** The task rows' runs or batches are still loading. */
  readonly loading: boolean;
  readonly opened: OpenedDigest;
  readonly onStart: () => void;
}

/** How a criterion is proven, in words. */
const CHECK_LABEL: Readonly<Record<CriterionCheck, string>> = {
  [CriterionCheck.Task]: 'Its task is done',
  [CriterionCheck.Merged]: 'Its pull request merges',
  [CriterionCheck.Command]: 'A command passes',
  [CriterionCheck.Accept]: 'You accept it',
};

/**
 * A goal on its own page. The left column says where it stands and its one next step, then what needs the
 * builder, its tasks and what changed; the right says what it is for: the objective, the notes, the
 * criteria and the session it was planned in. Its actions sit with its title, not in the title row.
 */
export function GoalPage({ project, summary, rows, loading, opened, onStart }: GoalPageProps) {
  const { goal, digest } = summary;
  const look = GOAL_STATUS_LOOK[digest.status];
  const ready = rows.filter((r) => r.bucket === 'ready').length;
  const step = nextStep(digest, ready);
  const removal = useRemoveDraftGoalAction(summary);
  return (
    <Container size={ContentWidth.Page} w="100%">
      <TitleRow title={goal.title} meta={<ScopeBadge name={project.name} />} />
      <Stack gap={6} pb="md">
        <Anchor
          renderRoot={(props) => <Link {...props} to="/goals" />}
          size="xs"
          c="dimmed"
          style={{ alignSelf: 'flex-start' }}
        >
          <Group gap={4} wrap="nowrap">
            <IconArrowLeft size={12} aria-hidden />
            All Goals
          </Group>
        </Anchor>
        <Group justify="space-between" wrap="nowrap" align="flex-start" gap="xl">
          <Stack gap={6} style={{ minWidth: 0 }}>
            <Text component="h2" fz={22} fw={650} c="bright" lh={1.25} m={0}>
              {goal.title}
            </Text>
            <Group gap="xs">
              <Badge color={look.color} variant="light" size="md" tt="none">
                {goalStatusWord(digest)}
              </Badge>
              {summary.newItems > 0 ? (
                <Text
                  size="sm"
                  c="dimmed"
                >{`${String(summary.newItems)} new since you looked`}</Text>
              ) : null}
            </Group>
          </Stack>
          <Menu position="bottom-end">
            <Menu.Target>
              <ActionIcon variant="default" size={30} aria-label="More goal actions">
                <IconDots size={16} aria-hidden />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                renderRoot={(props) => <Link {...props} to="/board" search={{ goal: goal.id }} />}
              >
                Show on Board
              </Menu.Item>
              <Menu.Item
                renderRoot={(props) => <Link {...props} to="/factory" search={{ goal: goal.id }} />}
              >
                Show in Factory
              </Menu.Item>
              {removal.offer === 'available' ? (
                <>
                  <Menu.Divider />
                  <Menu.Item
                    color="red"
                    leftSection={<IconTrash size={14} aria-hidden />}
                    onClick={removal.open}
                  >
                    Remove Draft Goal
                  </Menu.Item>
                </>
              ) : null}
            </Menu.Dropdown>
          </Menu>
        </Group>
      </Stack>
      {removal.modal}
      <Grid gap="xl" pb="xl">
        <Grid.Col span={{ base: 12, md: 7.5 }}>
          <Stack gap="lg">
            <NextStepPanel line={step.line} color={look.color}>
              <NextStepAction
                action={step.action}
                ready={ready}
                goalId={goal.id}
                onStart={onStart}
              />
            </NextStepPanel>
            <GoalBar digest={digest} rows={rows} />
            <NeedsYou digest={digest} rows={rows} />
            <WaitingOnOthers digest={digest} />
            <GoalTasks rows={rows} loading={loading} error={null} />
            <SinceYouLooked opened={opened} />
            <GoalFooter digest={digest} />
          </Stack>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 4.5 }}>
          <Stack gap="md">
            <AboutCard summary={summary} />
            <DoneWhen summary={summary} />
            <PlanCard summary={summary} />
          </Stack>
        </Grid.Col>
      </Grid>
    </Container>
  );
}

/** The next step's one button; a failed run's Retry is in Needs you, beside its reason. */
function NextStepAction({
  action,
  ready,
  goalId,
  onStart,
}: {
  readonly action: NextAction | null;
  readonly ready: number;
  readonly goalId: GoalSummaryDto['goal']['id'];
  readonly onStart: () => void;
}) {
  const navigate = useNavigate();
  switch (action) {
    case null:
    case NextAction.Retry:
      return null;
    case NextAction.Start:
      return (
        <Group gap="sm">
          <Button size="xs" onClick={onStart}>
            {`Start ${String(ready)} Ready Task${ready === 1 ? '' : 's'}`}
          </Button>
          <Text size="xs" c="dimmed">
            The rest start as what they wait on merges.
          </Text>
        </Group>
      );
    case NextAction.Answer:
      return (
        <Button
          size="xs"
          color="yellow"
          variant="light"
          style={{ alignSelf: 'flex-start' }}
          onClick={() => {
            void navigate({ to: '/inbox' });
          }}
        >
          Answer in Inbox
        </Button>
      );
    case NextAction.Merge:
      return (
        <Button
          size="xs"
          variant="default"
          style={{ alignSelf: 'flex-start' }}
          onClick={() => {
            void navigate({ to: '/board', search: { goal: goalId } });
          }}
        >
          Open Board
        </Button>
      );
  }
}

/** The goal's next step, ruled in its status colour, or the accent while it has not begun. */
function NextStepPanel({
  line,
  color,
  children,
}: {
  readonly line: string;
  readonly color: string;
  readonly children: ReactNode;
}) {
  return (
    <Paper
      variant="raised"
      radius="md"
      p="md"
      role="region"
      aria-label="Next step"
      style={{
        borderLeft: `3px solid var(--mantine-color-${color === 'gray' ? 'blue' : color}-6)`,
      }}
    >
      <Stack gap="sm">
        <Text size="xs" c="dimmed" fw={600} tt="uppercase">
          Next Step
        </Text>
        <Text size="sm" c="bright">
          {line}
        </Text>
        {children}
      </Stack>
    </Paper>
  );
}

function SideCard({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <Paper variant="raised" radius="md" p="md" role="region" aria-label={title}>
      <Stack gap="sm">
        <Text size="xs" c="dimmed" fw={600} tt="uppercase">
          {title}
        </Text>
        {children}
      </Stack>
    </Paper>
  );
}

/** Objective, what matters most and the notes (where a brief names its spec), folded to a few lines. */
function AboutCard({ summary }: { readonly summary: GoalSummaryDto }) {
  const { goal } = summary;
  const [whole, setWhole] = useState(false);
  const notes = goal.description.trim();
  return (
    <SideCard title="About This Goal">
      <Stack gap={4}>
        <Text size="xs" c="dimmed">
          Objective
        </Text>
        <Text size="sm">{goal.objective}</Text>
      </Stack>
      {goal.caresMost === null ? null : (
        <Stack gap={4}>
          <Text size="xs" c="dimmed">
            What matters most
          </Text>
          <Text size="sm" {...(whole ? {} : { lineClamp: 4 })}>
            {goal.caresMost}
          </Text>
        </Stack>
      )}
      {notes === '' ? null : (
        <Stack gap={4}>
          <Text size="xs" c="dimmed">
            Notes
          </Text>
          <Box
            fz="sm"
            style={
              whole
                ? undefined
                : {
                    maxHeight: 120,
                    overflow: 'hidden',
                    maskImage: 'linear-gradient(black 60%, transparent)',
                  }
            }
          >
            <Markdown text={notes} />
          </Box>
        </Stack>
      )}
      {notes === '' && goal.caresMost === null ? null : (
        <Anchor
          component="button"
          size="xs"
          style={{ alignSelf: 'flex-start' }}
          aria-expanded={whole}
          onClick={() => {
            setWhole(!whole);
          }}
        >
          {whole ? 'Show Less' : 'Show All'}
        </Anchor>
      )}
    </SideCard>
  );
}

/** The goal's criteria, each with how it is proven and whether it is. */
function DoneWhen({ summary }: { readonly summary: GoalSummaryDto }) {
  const { criteria } = summary.goal;
  const proven = criteria.filter((c) => c.state === CriterionState.Proven).length;
  return (
    <SideCard title="Done When">
      {criteria.length === 0 ? (
        <Text size="sm" c="dimmed">
          No criteria: the goal is done when every task has merged.
        </Text>
      ) : (
        <Stack gap={8}>
          <Text
            size="xs"
            c="dimmed"
          >{`${String(proven)} of ${String(criteria.length)} proven`}</Text>
          {criteria.map((c) => {
            const isProven = c.state === CriterionState.Proven;
            const Mark = isProven ? IconCircleCheck : IconCircleDashed;
            return (
              <Group key={c.id} gap={8} wrap="nowrap" align="flex-start">
                <Mark
                  size={16}
                  stroke={1.5}
                  aria-label={isProven ? 'Proven' : 'Not proven yet'}
                  color={isProven ? 'var(--mantine-color-green-5)' : 'var(--mantine-color-dimmed)'}
                  style={{ flex: 'none', marginTop: 2 }}
                />
                <Stack gap={0} style={{ minWidth: 0 }}>
                  <Text size="sm">{c.text}</Text>
                  <Text size="xs" c="dimmed">
                    {CHECK_LABEL[c.check]}
                  </Text>
                </Stack>
              </Group>
            );
          })}
        </Stack>
      )}
    </SideCard>
  );
}

/** Where the goal was planned: the session, which keeps its plan, or a word that it came from a brief. */
function PlanCard({ summary }: { readonly summary: GoalSummaryDto }) {
  const of = useShapeOf({ goalId: summary.goal.id });
  if (of.isPending) return null;
  return (
    <SideCard title="Plan">
      {of.data?.chatId == null ? (
        <Text size="sm" c="dimmed">
          Adopted from a brief, with no session of its own.
        </Text>
      ) : (
        <Stack gap={6}>
          <PlannedIn goalId={summary.goal.id} />
          <OpenPlanSession target={{ goalId: summary.goal.id }} />
        </Stack>
      )}
    </SideCard>
  );
}
