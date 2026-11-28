import {
  GoalStatus,
  type GoalId,
  type GoalListDto,
  type GoalSummaryDto,
  type ProjectViewDto,
} from '@10db/contracts';
import { Box } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { useOpenGoal } from '../../daemon/goal-queries';
import { useNow } from '../../shell/relative';
import { GoalDetail } from './goal-detail';
import { GoalRow } from './goal-row';
import { GOAL_STATUS_LOOK } from '../board/goal-status';
import { goalDetails, goalStatusWord, groupGoals, verdictLine } from './goal-status';
import { shortAgo } from './short-ago';
import { goalBar } from './factory-summary';
import { StackedBar } from './stacked-bar';

/** "3 new since 3h ago", when the goal has items in its window: the row's hover card says it whole. */
function newsOf(summary: GoalSummaryDto, now: number): string | undefined {
  if (summary.newItems === 0) return undefined;
  const since = summary.digest.since;
  return since === null
    ? `${String(summary.newItems)} new`
    : `${String(summary.newItems)} new since ${shortAgo(since, now)}`;
}

/**
 * The project's goals as one list: open goals in status order, then the done ones behind one collapsed
 * line. Work in no goal is listed under the goals, in its project's row. Every row starts collapsed and one is open at a time.
 */
export function GoalList({
  project,
  list,
  linkedGoalId,
}: {
  readonly project: ProjectViewDto;
  readonly list: GoalListDto;
  /** A link's goal (a goal page's "Show in Factory"): its row starts open, with the Done group open if it is in it. */
  readonly linkedGoalId?: GoalId | undefined;
}) {
  const now = useNow();
  const open = useOpenGoal();
  // A link to a goal this project does not have opens nothing.
  const linked = list.goals.find((g) => g.goal.id === linkedGoalId);
  const [openKey, setOpenKey] = useState<string | null>(linked?.goal.id ?? null);
  const [doneShown, setDoneShown] = useState(linked?.digest.status === GoalStatus.Done);
  const { open: goals, done } = groupGoals(list.goals);

  // A row opened by a link reads the digest once, as a click would; a ref keeps a StrictMode
  // remount from reading it twice and finding its own window closed.
  const openedForLink = useRef<GoalId | null>(null);
  const linkedId = linked?.goal.id;
  const { mutate } = open;
  useEffect(() => {
    if (linkedId === undefined || openedForLink.current === linkedId) return;
    openedForLink.current = linkedId;
    mutate(linkedId);
  }, [linkedId, mutate]);

  function toggleGoal(summary: GoalSummaryDto): void {
    if (openKey === summary.goal.id) {
      setOpenKey(null);
      return;
    }
    setOpenKey(summary.goal.id);
    open.mutate(summary.goal.id);
  }

  function goalRow(summary: GoalSummaryDto) {
    const id = summary.goal.id;
    const expanded = openKey === id;
    const news = newsOf(summary, now);
    const { merged, total } = summary.digest.progress;
    return (
      <GoalRow
        key={id}
        title={summary.goal.title}
        status={goalStatusWord(summary.digest)}
        waitsOnYou={summary.digest.status === GoalStatus.WaitingOnYou}
        // A goal that has not started has nothing merged to count.
        {...(summary.digest.status === GoalStatus.NotStarted
          ? {}
          : { count: `${String(merged)}/${String(total)}` })}
        {...(summary.newItems === 0 ? {} : { news: `${String(summary.newItems)} new` })}
        details={[...goalDetails(summary.digest), ...(news === undefined ? [] : [news])]}
        label={[summary.goal.title, verdictLine(summary.digest), news]
          .filter((part) => part !== undefined)
          .join(' ')}
        color={GOAL_STATUS_LOOK[summary.digest.status].color}
        bar={<StackedBar counts={goalBar(summary.digest.progress)} size="sm" tips={false} />}
        expanded={expanded}
        onToggle={() => {
          toggleGoal(summary);
        }}
      >
        <GoalDetail
          project={project}
          summary={summary}
          opened={{
            data: open.data?.goalId === id ? open.data : undefined,
            error: open.isError && open.variables === id ? open.error.message : null,
          }}
        />
      </GoalRow>
    );
  }

  return (
    <Box
      role="group"
      aria-label={`${project.name} goals`}
      style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}
    >
      {goals.map(goalRow)}
      {done.length > 0 ? (
        <GoalRow
          title="Done"
          status={done.length === 1 ? '1 goal' : `${String(done.length)} goals`}
          expanded={doneShown}
          flush
          onToggle={() => {
            setDoneShown(!doneShown);
          }}
        >
          <Box role="group" aria-label="Done goals">
            {done.map(goalRow)}
          </Box>
        </GoalRow>
      ) : null}
    </Box>
  );
}
