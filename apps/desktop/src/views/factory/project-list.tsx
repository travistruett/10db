import {
  GoalStatus,
  type GoalId,
  type GoalListDto,
  type ProjectId,
  type ProjectViewDto,
  type TaskId,
  type WorkstreamDto,
} from '@10db/contracts';
import {
  Accordion,
  Badge,
  Box,
  Collapse,
  Group,
  HoverCard,
  Stack,
  Text,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import { useState, type ReactNode } from 'react';
import { ProjectTile } from '../../shell/project-tile';
import { useSelectedProject } from '../../shell/selected-project';
import {
  barCounts,
  projectLine,
  projectRank,
  startsOpen,
  type BarCounts,
  type LiveRow,
} from './factory-summary';
import classes from './factory-overview.module.css';
import { ClippedText } from './clipped-text';
import { GoalList } from './goal-list';
import { LiveGroup, lastMoment } from './live-groups';
import { shortAgo } from './short-ago';
import { BarBreakdown, StackedBar } from './stacked-bar';
import { doing, failedAt, LineTone, RunMark, TaskLine } from './task-line';
import { FailureDot } from './failure-card';
import { STATE_COLORS } from './workstream-state';

/** A goal in one of these opens its project's row, as a run that needs the builder or runs would. */
const OPENING_GOALS: ReadonlySet<GoalStatus> = new Set([
  GoalStatus.Failed,
  GoalStatus.WaitingOnYou,
  GoalStatus.Running,
]);

/** A UI Workbench pass at work, which reads as a running line of its project. */
export interface BusyPass {
  readonly key: string;
  readonly projectId: ProjectId;
  readonly title: string;
}

export interface ProjectEntry {
  readonly project: ProjectViewDto;
  readonly rows: readonly LiveRow[];
  readonly passes: readonly BusyPass[];
  /** Workbench passes of this project with pages waiting on the builder. */
  readonly asks: number;
  readonly goals: GoalListDto | undefined;
}

export interface ProjectListProps {
  readonly entries: readonly ProjectEntry[];
  /** Each task's goal, for telling a project's work in a goal from the rest. */
  readonly goalOf: ReadonlyMap<TaskId, GoalId | null>;
  readonly linkedGoalId: GoalId | undefined;
  readonly now: number;
  /** Whether the daemon takes a retry of this failed run. */
  readonly canRetry: (ws: WorkstreamDto) => boolean;
  /** Whether the daemon closes this failed run's task. */
  readonly canClose: (ws: WorkstreamDto) => boolean;
  readonly onOpen: (ws: WorkstreamDto) => void;
  readonly onOpenPass: (projectId: ProjectId) => void;
}

/** A line that opens and closes the lines under it, such as "5 pull requests open". */
function Fold({
  label,
  detail,
  mark,
  children,
}: {
  readonly label: string;
  readonly detail: string;
  readonly mark: ReactNode;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? IconChevronDown : IconChevronRight;
  return (
    <>
      <div className={classes['line']}>
        <div className={classes['cols']}>
          <span className={classes['lineMark']}>{mark}</span>
          <UnstyledButton
            className={classes['lineOpen']}
            aria-expanded={open}
            onClick={() => {
              setOpen(!open);
            }}
          >
            <ClippedText text={label} className={classes['lineTitle']} />
            <ClippedText text={detail} c="dimmed" className={classes['lineState']} wide />
            <span className={classes['when']}>
              <Chevron size={14} stroke={1.5} aria-hidden />
            </span>
          </UnstyledButton>
        </div>
      </div>
      <Collapse expanded={open} keepMounted={false} pl={24}>
        {children}
      </Collapse>
    </>
  );
}

/** The work of a project that is in no goal: what needs the builder and what moves, then folds for the rest. */
function Work({
  rows,
  passes,
  now,
  canRetry,
  canClose,
  onOpen,
  onOpenPass,
}: {
  readonly rows: readonly LiveRow[];
  readonly passes: readonly BusyPass[];
  readonly now: number;
  readonly canRetry: (ws: WorkstreamDto) => boolean;
  readonly canClose: (ws: WorkstreamDto) => boolean;
  readonly onOpen: (ws: WorkstreamDto) => void;
  readonly onOpenPass: (projectId: ProjectId) => void;
}) {
  const of = (group: LiveGroup): WorkstreamDto[] =>
    rows.filter((r) => r.group === group).map((r) => r.run);
  const line = (run: WorkstreamDto, group: LiveGroup) => {
    const failed = group === LiveGroup.Failed;
    return (
      <TaskLine
        key={run.id}
        mark={
          failed ? (
            <FailureDot
              run={run}
              canRetry={canRetry(run)}
              canClose={canClose(run)}
              onOpen={() => {
                onOpen(run);
              }}
            />
          ) : (
            // A finished run whose pull request is open is in review: blue, never done's green.
            <RunMark color={group === LiveGroup.InReview ? 'blue' : STATE_COLORS[run.state]} />
          )
        }
        title={run.taskTitle}
        run={run}
        detail={
          group === LiveGroup.InReview ? 'Pull request open' : failed ? failedAt(run) : doing(run)
        }
        tone={group === LiveGroup.NeedsYou ? LineTone.You : LineTone.Plain}
        when={shortAgo(lastMoment(run), now)}
        onOpen={() => {
          onOpen(run);
        }}
      />
    );
  };
  const inReview = of(LiveGroup.InReview);
  const merged = of(LiveGroup.Done);
  return (
    <>
      {[LiveGroup.NeedsYou, LiveGroup.Failed, LiveGroup.Running, LiveGroup.Waiting].flatMap(
        (group) => of(group).map((run) => line(run, group)),
      )}
      {passes.map((pass) => (
        <TaskLine
          key={pass.key}
          mark={<RunMark color="blue" />}
          title={pass.title}
          detail="UI Workbench"
          when=""
          onOpen={() => {
            onOpenPass(pass.projectId);
          }}
        />
      ))}
      {inReview.length > 0 ? (
        <Fold
          mark={<RunMark color="blue" />}
          label={`${String(inReview.length)} ${inReview.length === 1 ? 'pull request' : 'pull requests'} open`}
          detail="In review"
        >
          {inReview.map((run) => line(run, LiveGroup.InReview))}
        </Fold>
      ) : null}
      {merged.length > 0 ? (
        <Fold
          mark={<RunMark color="green" />}
          label={`${String(merged.length)} merged today`}
          detail="Done"
        >
          {merged.map((run) => line(run, LiveGroup.Done))}
        </Fold>
      ) : null}
    </>
  );
}

/** A project's row: the control (tile, name, bar, line, when) and, opened, its goals and its other work. */
function ProjectItem({
  entry,
  props,
}: {
  readonly entry: ProjectEntry;
  readonly props: ProjectListProps;
}) {
  const { project, rows, passes, goals } = entry;
  const { select } = useSelectedProject();
  const counts = withPasses(entry);
  const line = projectLine(counts);
  // Nothing needs the builder, runs or waits: the bar steps back so busy projects stand out.
  const idle = projectRank(counts) === 2;
  const latest = latestOf(entry);
  const hasGoals = goals !== undefined && goals.goals.length > 0;
  const loose = hasGoals
    ? rows.filter((r) => (props.goalOf.get(r.run.taskId) ?? null) === null)
    : rows;
  return (
    <Accordion.Item value={project.id}>
      <Accordion.Control aria-label={`${project.name} ${line}`}>
        <Group gap={12} wrap="nowrap">
          <ProjectTile name={project.name} size={18} />
          {/* 220 px puts the bar on the goal rows' bar column below. */}
          <Text fw={600} c="bright" truncate w={220} style={{ flex: 'none' }}>
            {project.name}
          </Text>
          <HoverCard position="bottom-start" openDelay={150} shadow="md" width={300}>
            <HoverCard.Target>
              <Box
                py={6}
                // The bar gives way before the badges do on a narrow card.
                style={{ flex: '0 1 240px', minWidth: 60, opacity: idle ? 0.45 : undefined }}
              >
                <StackedBar counts={counts} tips={false} />
              </Box>
            </HoverCard.Target>
            <HoverCard.Dropdown>
              <BarBreakdown counts={counts} verdict={line} />
            </HoverCard.Dropdown>
          </HoverCard>
          {/* Only what needs the builder has words beside the bar; the hover card says the rest. */}
          <Group gap={6} wrap="nowrap" ml={10} style={{ flex: '1 0 auto' }}>
            {counts.needs_you > 0 ? (
              <Badge size="xs" variant="light" color="yellow">
                {`${String(counts.needs_you)} need you`}
              </Badge>
            ) : null}
            {counts.failed > 0 ? (
              <Badge size="xs" variant="light" color="red">
                {`${String(counts.failed)} failed`}
              </Badge>
            ) : null}
          </Group>
          <Text size="xs" c="dimmed" w={64} ta="right" style={{ flex: 'none' }}>
            {latest === '' ? '' : shortAgo(latest, props.now)}
          </Text>
        </Group>
      </Accordion.Control>
      <Accordion.Panel
        // Capture runs before a click reaches a link inside, so the project is chosen first.
        onClickCapture={() => {
          select(project.id);
        }}
      >
        {hasGoals ? (
          <GoalList project={project} list={goals} linkedGoalId={props.linkedGoalId} />
        ) : null}
        {hasGoals && loose.length + passes.length > 0 ? (
          <Text size="xs" fw={600} c="dimmed" pt={16} pb={6}>
            Not in a goal
          </Text>
        ) : null}
        <Work
          rows={loose}
          passes={passes}
          now={props.now}
          canRetry={props.canRetry}
          canClose={props.canClose}
          onOpen={props.onOpen}
          onOpenPass={props.onOpenPass}
        />
        {!hasGoals && loose.length + passes.length === 0 ? (
          <Text size="xs" c="dimmed" pt={4}>
            Nothing open
          </Text>
        ) : null}
      </Accordion.Panel>
    </Accordion.Item>
  );
}

const latestOf = (e: ProjectEntry): string =>
  e.rows
    .map((r) => lastMoment(r.run))
    .sort()
    .at(-1) ?? '';

/** A project's counts, with its Workbench passes: waiting on the builder as needs you, busy as running. */
const withPasses = (e: ProjectEntry): BarCounts => {
  const counts = barCounts(e.rows);
  return {
    ...counts,
    needs_you: counts.needs_you + e.asks,
    running: counts.running + e.passes.length,
  };
};

/**
 * Every shown project as an accordion row: its bar and one line, then, opened, its goals and the rest of its
 * work. Projects that need the builder come first and start open, idle ones last and folded.
 */
export function ProjectList(props: ProjectListProps) {
  const { entries, linkedGoalId } = props;
  const ranked = [...entries].sort(
    (a, b) =>
      projectRank(withPasses(a)) - projectRank(withPasses(b)) ||
      latestOf(b).localeCompare(latestOf(a)) ||
      a.project.name.localeCompare(b.project.name),
  );
  const holdsLinked = (e: ProjectEntry): boolean =>
    linkedGoalId !== undefined && (e.goals?.goals.some((g) => g.goal.id === linkedGoalId) ?? false);
  const goalAsks = (e: ProjectEntry): boolean =>
    e.goals?.goals.some((g) => OPENING_GOALS.has(g.digest.status)) ?? false;
  // One project shown opens whatever it holds; several open only those with something going on.
  const opened = ranked
    .filter(
      (e) => entries.length === 1 || startsOpen(withPasses(e)) || goalAsks(e) || holdsLinked(e),
    )
    .map((e) => e.project.id);
  return (
    <Stack component="section" aria-labelledby="factory-projects" gap={12}>
      <Title id="factory-projects" order={2} fz={14} fw={600} c="bright">
        Projects
      </Title>
      <Accordion
        multiple
        variant="separated"
        defaultValue={opened}
        chevronPosition="left"
        keepMounted={false}
        // Folded points right and open points down, as the goal rows inside do.
        chevron={<IconChevronRight size={16} stroke={1.5} />}
        classNames={{
          chevron: classes['chevron'],
          item: classes['projectCard'],
          control: classes['projectControl'],
          label: classes['projectLabel'],
          content: classes['projectContent'],
        }}
      >
        {ranked.map((entry) => (
          <ProjectItem key={entry.project.id} entry={entry} props={props} />
        ))}
      </Accordion>
    </Stack>
  );
}
