import type { GoalListDto, GoalSummaryDto } from '@10db/contracts';
import { Box } from '@mantine/core';
import { useState } from 'react';
import { useOpenGoal } from '../../daemon/goal-queries';
import { useNow } from '../../shell/relative';
import { GoalDetail, UngroupedDetail } from './goal-detail';
import { GoalRow } from './goal-row';
import { GOAL_STATUS_LOOK } from '../board/goal-status';
import { groupGoals, ungroupedLine, verdictLine } from './goal-status';
import { shortAgo } from './short-ago';

/** The row key of the Ungrouped group, beside the goals' ids. */
const UNGROUPED = 'ungrouped';

/** "· 3 new since 3h ago": plain text, with no badge, when the goal has items in its window. */
function newsOf(summary: GoalSummaryDto, now: number): string | undefined {
  if (summary.newItems === 0) return undefined;
  const since = summary.digest.since;
  return since === null
    ? `· ${String(summary.newItems)} new`
    : `· ${String(summary.newItems)} new since ${shortAgo(since, now)}`;
}

/**
 * The project's goals as one list: open goals in status order, Ungrouped, then the done ones
 * behind one collapsed line. Every row starts collapsed and one is open at a time.
 */
export function GoalList({ list }: { readonly list: GoalListDto }) {
  const now = useNow();
  const open = useOpenGoal();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [doneShown, setDoneShown] = useState(false);
  const { open: goals, done } = groupGoals(list.goals);

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
    return (
      <GoalRow
        key={id}
        title={summary.goal.title}
        line={verdictLine(summary.digest)}
        news={newsOf(summary, now)}
        color={GOAL_STATUS_LOOK[summary.digest.status].color}
        expanded={expanded}
        onToggle={() => {
          toggleGoal(summary);
        }}
      >
        <GoalDetail
          live={summary.digest}
          taskIds={summary.goal.taskIds}
          opened={{
            data: open.data?.goalId === id ? open.data : undefined,
            error: open.isError && open.variables === id ? open.error.message : null,
          }}
        />
      </GoalRow>
    );
  }

  const { ungrouped } = list;
  return (
    <Box
      role="group"
      aria-label="Goals"
      style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}
    >
      {goals.map(goalRow)}
      {ungrouped ? (
        <GoalRow
          title="Ungrouped"
          line={ungroupedLine(ungrouped)}
          color={GOAL_STATUS_LOOK[ungrouped.status].color}
          expanded={openKey === UNGROUPED}
          onToggle={() => {
            setOpenKey(openKey === UNGROUPED ? null : UNGROUPED);
          }}
        >
          <UngroupedDetail workstreamIds={ungrouped.workstreams.map((w) => w.workstreamId)} />
        </GoalRow>
      ) : null}
      {done.length > 0 ? (
        <GoalRow
          title={`Done (${String(done.length)})`}
          line=""
          expanded={doneShown}
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
