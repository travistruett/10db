import type { ProjectId, ProjectViewDto } from '@10db/contracts';
import { Alert, Group, SegmentedControl, Stack, Text } from '@mantine/core';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useRef } from 'react';
import { ProjectFilter } from '../../shell/project-filter';
import { useSelectedProject } from '../../shell/selected-project';
import { TitleRow } from '../../shell/title-row';
import { ActivityButton } from './activity-drawer';
import { AcceptancePanel } from './acceptance-panel';
import { AdmissionNote } from './admission-note';
import { BenchmarkSyncNote } from './benchmark-sync-note';
import { CardTypesPanel } from './card-types-panel';
import { FactoryOverview } from './factory-overview';
import { HumanTouchPanel } from './human-touch-panel';
import { RigorPanel } from './rigor-panel';
import { UpdateDrainNote } from './update-drain-note';

/** What Factory shows: what runs now across projects, or how one project's work has gone. */
export const FactoryMode = { Live: 'live', Metrics: 'metrics' } as const;
export type FactoryMode = (typeof FactoryMode)[keyof typeof FactoryMode];

/**
 * Factory: where work stands across projects (what needs the builder, then each project's bar, goals and
 * work); or, under Metrics, one project's work per rigor and how often a person was needed. Narrowed by
 * the view's own project filter.
 */
export function FactoryView() {
  const { projects, project: railProject } = useSelectedProject();
  const { goal: linkedGoalId, project: filter, view } = useSearch({ from: '/factory' });
  const navigate = useNavigate({ from: '/factory' });
  const all = projects.data ?? [];
  const shown = filter === undefined ? all : all.filter((p) => p.id === filter);
  const mode = view ?? FactoryMode.Live;
  // The project Metrics chose by itself, so going back to Live shows every project again.
  const metricsChose = useRef<ProjectId | null>(null);

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
            <UpdateDrainNote />
            <ActivityButton project={filter ?? null} />
            <SegmentedControl
              size="xs"
              aria-label="Factory view"
              value={mode}
              onChange={(value) => {
                // Metrics is one project's: with every project shown, it opens on the rail's.
                if (value === FactoryMode.Metrics) {
                  metricsChose.current = filter === undefined ? (railProject?.id ?? null) : null;
                  go({ view: FactoryMode.Metrics, project: filter ?? railProject?.id ?? null });
                } else {
                  const chosen = metricsChose.current;
                  metricsChose.current = null;
                  go({
                    view: FactoryMode.Live,
                    ...(chosen !== null && chosen === filter ? { project: null } : {}),
                  });
                }
              }}
              data={[
                { value: FactoryMode.Live, label: 'Live' },
                { value: FactoryMode.Metrics, label: 'Metrics' },
              ]}
            />
            <ProjectFilter
              projects={all}
              value={filter ?? null}
              onChange={(project) => {
                go({ project });
              }}
            />
          </Group>
        }
      />
      <AdmissionNote />
      {projects.isError ? (
        <Alert color="red" title="Couldn't load the projects">
          {projects.error.message}
        </Alert>
      ) : null}
      {mode === FactoryMode.Metrics ? (
        <Metrics shown={shown} />
      ) : (
        <FactoryOverview projects={all} filter={filter ?? null} linkedGoalId={linkedGoalId} />
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
      <AcceptancePanel projectId={only.id} />
      <RigorPanel projectId={only.id} />
      <HumanTouchPanel projectId={only.id} />
      <CardTypesPanel projectId={only.id} />
    </>
  );
}
