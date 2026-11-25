import {
  GoalStatus,
  type GoalId,
  type GoalListDto,
  type ProjectId,
  type ProjectViewDto,
  type TaskId,
  type WorkstreamDto,
} from '@10db/contracts';
import { UnstyledButton } from '@mantine/core';
import { IconChevronDown, IconChevronRight, IconTools } from '@tabler/icons-react';
import { useId, useState, type ReactNode } from 'react';
import { ProjectTile } from '../../shell/project-tile';
import { failureLine } from '../board/task-state';
import { useSelectedProject } from '../../shell/selected-project';
import { barCounts, projectLine, projectRank, startsOpen, type LiveRow } from './factory-summary';
import classes from './factory-overview.module.css';
import { GoalList } from './goal-list';
import { LiveGroup, lastMoment } from './live-groups';
import { shortAgo } from './short-ago';
import { BarLegend, StackedBar } from './stacked-bar';
import { doing, LineTone, RunMark, TaskLine } from './task-line';
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
  readonly goals: GoalListDto | undefined;
}

export interface ProjectListProps {
  readonly entries: readonly ProjectEntry[];
  /** Each task's goal, for telling a project's work in a goal from the rest. */
  readonly goalOf: ReadonlyMap<TaskId, GoalId | null>;
  readonly linkedGoalId: GoalId | undefined;
  readonly now: number;
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
        <UnstyledButton
          className={classes['lineOpen']}
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
          }}
        >
          <span className={classes['lineMark']}>{mark}</span>
          <span className={classes['clip']}>{label}</span>
          <span />
          <span className={`${classes['lineDetail'] ?? ''} ${classes['clip'] ?? ''}`}>
            {detail}
          </span>
          <span className={classes['when']}>
            <Chevron size={14} stroke={1.5} aria-hidden />
          </span>
        </UnstyledButton>
        <span className={classes['lineAction']} />
      </div>
      {open ? <div style={{ paddingLeft: 24 }}>{children}</div> : null}
    </>
  );
}

/** The work of a project that is in no goal: what needs the builder and what moves, then folds for the rest. */
function Work({
  rows,
  passes,
  now,
  onOpen,
  onOpenPass,
}: {
  readonly rows: readonly LiveRow[];
  readonly passes: readonly BusyPass[];
  readonly now: number;
  readonly onOpen: (ws: WorkstreamDto) => void;
  readonly onOpenPass: (projectId: ProjectId) => void;
}) {
  const of = (group: LiveGroup): WorkstreamDto[] =>
    rows.filter((r) => r.group === group).map((r) => r.run);
  const line = (run: WorkstreamDto, group: LiveGroup) => {
    const tone =
      group === LiveGroup.NeedsYou
        ? LineTone.You
        : group === LiveGroup.Failed
          ? LineTone.Failed
          : LineTone.Plain;
    return (
      <TaskLine
        key={run.id}
        // A finished run whose pull request is open is in review: blue, never done's green.
        mark={<RunMark color={group === LiveGroup.InReview ? 'blue' : STATE_COLORS[run.state]} />}
        title={run.taskTitle}
        run={run}
        detail={
          group === LiveGroup.InReview
            ? 'Pull request open'
            : group === LiveGroup.Failed
              ? failureLine(run, false)
              : doing(run)
        }
        tone={tone}
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
          action={<IconTools size={14} stroke={1.5} aria-hidden />}
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

function ProjectRow({
  entry,
  initiallyOpen,
  props,
}: {
  readonly entry: ProjectEntry;
  readonly initiallyOpen: boolean;
  readonly props: ProjectListProps;
}) {
  const { project, rows, passes, goals } = entry;
  const { select } = useSelectedProject();
  const [open, setOpen] = useState(initiallyOpen);
  const id = useId();
  const counts = barCounts(rows);
  const withPasses = { ...counts, running: counts.running + passes.length };
  const latest = rows
    .map((r) => lastMoment(r.run))
    .sort()
    .at(-1);
  const hasGoals = goals !== undefined && goals.goals.length > 0;
  const loose = hasGoals
    ? rows.filter((r) => (props.goalOf.get(r.run.taskId) ?? null) === null)
    : rows;
  const Chevron = open ? IconChevronDown : IconChevronRight;
  return (
    <div className={classes['project']}>
      <UnstyledButton
        className={classes['projectHead']}
        aria-expanded={open}
        aria-controls={`${id}-region`}
        aria-labelledby={`${id}-title ${id}-line`}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <Chevron size={16} stroke={1.5} aria-hidden />
        <ProjectTile name={project.name} size={18} />
        <span
          id={`${id}-title`}
          className={`${classes['projectName'] ?? ''} ${classes['clip'] ?? ''}`}
        >
          {project.name}
        </span>
        <StackedBar counts={withPasses} />
        <span
          id={`${id}-line`}
          className={`${classes['projectLine'] ?? ''} ${classes['clip'] ?? ''}`}
        >
          {projectLine(withPasses)}
        </span>
        <span className={classes['when']}>
          {latest === undefined ? '' : shortAgo(latest, props.now)}
        </span>
      </UnstyledButton>
      {open ? (
        <div
          id={`${id}-region`}
          role="region"
          aria-labelledby={`${id}-title`}
          className={classes['projectBody']}
          // Capture runs before a click reaches a link inside, so the project is chosen first.
          onClickCapture={() => {
            select(project.id);
          }}
        >
          {hasGoals ? (
            <GoalList project={project} list={goals} linkedGoalId={props.linkedGoalId} />
          ) : null}
          {hasGoals && loose.length + passes.length > 0 ? (
            <div className={classes['groupLabel']}>Not in a goal</div>
          ) : null}
          <Work
            rows={loose}
            passes={passes}
            now={props.now}
            onOpen={props.onOpen}
            onOpenPass={props.onOpenPass}
          />
          {!hasGoals && loose.length + passes.length === 0 ? (
            <div className={classes['groupLabel']}>Nothing open</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Every shown project as an accordion row: its bar and one line, then, opened, its goals and the rest of its
 * work. Projects that need the builder come first and start open, idle ones last and folded.
 */
export function ProjectList(props: ProjectListProps) {
  const { entries, linkedGoalId } = props;
  const latest = (e: ProjectEntry): string =>
    e.rows
      .map((r) => lastMoment(r.run))
      .sort()
      .at(-1) ?? '';
  const ranked = entries
    .map((entry) => ({ entry, counts: barCounts(entry.rows) }))
    .sort(
      (a, b) =>
        projectRank(a.counts) - projectRank(b.counts) ||
        latest(b.entry).localeCompare(latest(a.entry)) ||
        a.entry.project.name.localeCompare(b.entry.project.name),
    );
  const holdsLinked = (e: ProjectEntry): boolean =>
    linkedGoalId !== undefined && (e.goals?.goals.some((g) => g.goal.id === linkedGoalId) ?? false);
  const goalAsks = (e: ProjectEntry): boolean =>
    e.goals?.goals.some((g) => OPENING_GOALS.has(g.digest.status)) ?? false;
  return (
    <section aria-labelledby="factory-projects">
      <div className={classes['sectionHead']} style={{ paddingBottom: 8 }}>
        <h2 id="factory-projects" className={classes['sectionTitle']}>
          Projects
        </h2>
        <BarLegend />
      </div>
      <div className={classes['projects']}>
        {ranked.map(({ entry, counts }) => (
          <ProjectRow
            key={entry.project.id}
            entry={entry}
            // One project shown opens whatever it holds; several open only those with something going on.
            initiallyOpen={
              entries.length === 1 ||
              startsOpen(counts) ||
              entry.passes.length > 0 ||
              goalAsks(entry) ||
              holdsLinked(entry)
            }
            props={props}
          />
        ))}
      </div>
    </section>
  );
}
