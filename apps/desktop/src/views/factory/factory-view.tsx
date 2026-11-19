import type { GoalId, ProjectId, ProjectViewDto } from '@10db/contracts';
import { Alert, Button, Group, SegmentedControl, Stack, Text } from '@mantine/core';
import { useQueries } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { goalsQueryOptions } from '../../daemon/goal-queries';
import { useDaemon } from '../../daemon/provider';
import { ProjectFilter } from '../../shell/project-filter';
import { ProjectTile } from '../../shell/project-tile';
import { useSelectedProject } from '../../shell/selected-project';
import { TitleRow } from '../../shell/title-row';
import { ActivityButton } from './activity-drawer';
import { AdmissionNote } from './admission-note';
import { BenchmarkSyncNote } from './benchmark-sync-note';
import { CardTypesPanel } from './card-types-panel';
import { GoalList } from './goal-list';
import { HumanTouchPanel } from './human-touch-panel';
import { LiveList, Section } from './live-list';
import { RigorPanel } from './rigor-panel';
import { UpdateDrainNote } from './update-drain-note';

/** What Factory shows: what runs now across projects, or how one project's work has gone. */
export const FactoryMode = { Live: 'live', Metrics: 'metrics' } as const;
export type FactoryMode = (typeof FactoryMode)[keyof typeof FactoryMode];

/**
 * Factory: what every project's runs are doing now, by what the builder would do about them (the live
 * list), then the open goals; or, under Metrics, one project's work per rigor and how often a person
 * was needed. Narrowed by the view's own project filter.
 */
export function FactoryView() {
  const { projects } = useSelectedProject();
  const { goal: linkedGoalId, project: filter, view } = useSearch({ from: '/factory' });
  const navigate = useNavigate({ from: '/factory' });
  const all = projects.data ?? [];
  const shown = filter === undefined ? all : all.filter((p) => p.id === filter);
  const mode = view ?? FactoryMode.Live;

  function go(next: { project?: ProjectId | null; view?: FactoryMode }): void {
    void navigate({
      search: (prev) => {
        const project = next.project === undefined ? prev.project : (next.project ?? undefined);
        const shownView = next.view ?? prev.view;
        return {
          ...(prev.goal === undefined ? {} : { goal: prev.goal }),
          ...(project === undefined ? {} : { project }),
          ...(shownView === undefined || shownView === FactoryMode.Live ? {} : { view: shownView }),
        };
      },
    });
  }

  return (
    <Stack>
      <TitleRow
        title="Factory"
        meta={<BenchmarkSyncNote />}
        actions={
          <Group gap="xs" wrap="nowrap">
            <SegmentedControl
              size="xs"
              aria-label="Factory view"
              value={mode}
              onChange={(value) => {
                go({
                  view: value === FactoryMode.Metrics ? FactoryMode.Metrics : FactoryMode.Live,
                });
              }}
              data={[
                { value: FactoryMode.Live, label: 'Live' },
                { value: FactoryMode.Metrics, label: 'Metrics' },
              ]}
            />
            <ActivityButton project={filter ?? null} />
            <ProjectFilter
              projects={all}
              value={filter ?? null}
              onChange={(project) => {
                go({ project });
              }}
            />
            <Button component={Link} to="/shape" size="xs">
              Plan Work
            </Button>
          </Group>
        }
      />
      <UpdateDrainNote />
      <AdmissionNote />
      {projects.isError ? (
        <Alert color="red" title="Couldn't load the projects">
          {projects.error.message}
        </Alert>
      ) : null}
      {mode === FactoryMode.Metrics ? (
        <Metrics shown={shown} />
      ) : (
        <>
          <LiveList projects={all} filter={filter ?? null} />
          <Goals shown={shown} linkedGoalId={linkedGoalId} />
        </>
      )}
    </Stack>
  );
}

/** One project's figures; across every project they would mix rigors and teams, so it asks for one. */
function Metrics({ shown }: { readonly shown: readonly ProjectViewDto[] }) {
  const only = shown.length === 1 ? shown[0] : undefined;
  if (only === undefined) {
    return (
      <Text size="sm" c="dimmed">
        Choose a project to see its work per rigor and how often a person was needed in it.
      </Text>
    );
  }
  return (
    <>
      <RigorPanel projectId={only.id} />
      <HumanTouchPanel projectId={only.id} />
      <CardTypesPanel projectId={only.id} />
    </>
  );
}

/**
 * The goals of the projects shown, under their project's name; nothing at all while no project has one,
 * so a builder who doesn't use goals never reads about them.
 */
function Goals({
  shown,
  linkedGoalId,
}: {
  readonly shown: readonly ProjectViewDto[];
  readonly linkedGoalId: GoalId | undefined;
}) {
  const { client } = useDaemon();
  const { select } = useSelectedProject();
  const lists = useQueries({ queries: shown.map((p) => goalsQueryOptions(client, p.id)) });
  const withGoals = shown.flatMap((project, i) => {
    const list = lists[i]?.data;
    return list === undefined || list.goals.length === 0 ? [] : [{ project, list }];
  });
  const failed = lists.find((q) => q.isError)?.error;
  if (withGoals.length === 0 && failed == null) return null;
  return (
    <Section label="Goals" count={withGoals.reduce((n, g) => n + g.list.goals.length, 0)}>
      {failed == null ? null : (
        <Alert color="red" title="Couldn't load the goals">
          {failed.message}
        </Alert>
      )}
      {withGoals.map(({ project, list }) => (
        // Capture runs before a click reaches a link inside the goal, so its project is chosen first.
        <Stack
          key={project.id}
          gap={4}
          onClickCapture={() => {
            select(project.id);
          }}
        >
          <Group gap={6} px={12} wrap="nowrap">
            <ProjectTile name={project.name} size={14} />
            <Text size="xs" c="dimmed">
              {project.name}
            </Text>
          </Group>
          <GoalList project={project} list={list} linkedGoalId={linkedGoalId} />
        </Stack>
      ))}
    </Section>
  );
}
