import { Alert, Stack, Text } from '@mantine/core';
import { passHoldsTasks, WorkstreamState } from '@10db/contracts';
import { useQuery } from '@tanstack/react-query';
import { useAdmission } from '../daemon/admission-queries';
import { livePassesOptions } from '../daemon/pass-queries';
import { useDaemon } from '../daemon/provider';
import { useInbox, useProjects, useTasksOfProjects, useWorkstreams } from '../daemon/queries';
import { PageLoading, PageLoadingShape } from '../shell/page-loading';
import { useNow } from '../shell/relative';
import { TitleRow } from '../shell/title-row';
import { failureCauses, flatRows } from '../views/factory/factory-summary';
import { GlanceTiles } from '../views/factory/glance-tiles';
import { LiveGroup, liveGroups } from '../views/factory/live-groups';
import { livePassesOf } from '../views/factory/live-passes';

/**
 * The phone's Factory: the five figures Factory shows at a glance, read-only. What needs the builder is in the
 * Inbox; everything else about a run waits for the window.
 */
export function FactoryGlance() {
  const now = useNow();
  const projects = useProjects();
  const runs = useWorkstreams({ active: false });
  const admission = useAdmission().data;
  const { client } = useDaemon();
  const passes = useQuery(livePassesOptions(client));
  const inbox = useInbox().data ?? [];
  const taskLists = useTasksOfProjects((projects.data ?? []).map((p) => p.id));
  const tasks = new Map(taskLists.flatMap((q) => q.data ?? []).map((t) => [t.id, t]));
  const heading = <TitleRow title="Factory" />;
  const failedToLoad = projects.error ?? runs.error;
  if (failedToLoad !== null) {
    return (
      <>
        {heading}
        <Alert color="red" title="Couldn't load the Factory">
          {failedToLoad.message}
        </Alert>
      </>
    );
  }
  if (
    runs.isPending ||
    passes.isPending ||
    projects.isPending ||
    taskLists.some((q) => q.isPending)
  ) {
    return (
      <>
        {heading}
        <PageLoading shape={PageLoadingShape.List} rows={3} label="Loading the Factory" />
      </>
    );
  }
  // A page's run is its pass's, never a line of its own.
  const heldByPass = new Set(
    (passes.data ?? [])
      .filter((view) => passHoldsTasks(view.pass.state))
      .flatMap((view) => view.pages.map((p) => p.taskId)),
  );
  const rows = flatRows(
    liveGroups(
      runs.data ?? [],
      tasks,
      taskLists.every((q) => q.isSuccess),
      heldByPass,
      now,
    ),
  );
  // A Workbench pass with ready pages needs the builder as a card does, and one still working is running.
  const livePasses = livePassesOf(passes.data ?? [], inbox, now, () => true);
  const waitingPasses = livePasses.filter((p) => p.waiting > 0).length;
  const busyPasses = livePasses.length - waitingPasses;
  const of = (group: LiveGroup) => rows.filter((r) => r.group === group).map((r) => r.run);
  const failed = of(LiveGroup.Failed);
  return (
    <Stack gap="md">
      {heading}
      <GlanceTiles
        cols={2}
        figures={{
          needsYou: of(LiveGroup.NeedsYou).length + waitingPasses,
          failed: failed.length,
          causes: failureCauses(failed).length,
          running: admission?.lanesRunning ?? of(LiveGroup.Running).length + busyPasses,
          laneCap: admission?.machineLaneCap ?? null,
          queued: of(LiveGroup.Waiting).filter((ws) => ws.state === WorkstreamState.Queued).length,
          inReview: of(LiveGroup.InReview).length,
          merged: of(LiveGroup.Done).length,
        }}
      />
      <Text size="sm" c="dimmed">
        What needs you is in the Inbox. Plans, the Board and the rest are in the 10db window on your
        Mac.
      </Text>
    </Stack>
  );
}
