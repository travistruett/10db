import { passHoldsTasks, type GoalId, type ProjectId, type ProjectViewDto } from '@10db/contracts';
import { Alert, Box, Button, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useId } from 'react';
import { useGoals } from '../../daemon/goal-queries';
import { useLivePass } from '../../daemon/pass-queries';
import { useInbox } from '../../daemon/queries';
import { useNow } from '../../shell/relative';
import { ProjectFilter } from '../../shell/project-filter';
import { ProjectTile } from '../../shell/project-tile';
import { useSelectedProject } from '../../shell/selected-project';
import { BenchmarkSyncNote } from './benchmark-sync-note';
import { GoalList } from './goal-list';
import { HumanTouchPanel } from './human-touch-panel';
import { UpdateDrainNote } from './update-drain-note';
import { PassLine } from '../workbench/pass-line';

/**
 * Factory: every project's goals, each opening to its digest, sessions and pull requests (goals spec §8),
 * grouped by project and narrowed by the view's own project filter.
 */
export function FactoryView() {
  const { projects } = useSelectedProject();
  const { goal: linkedGoalId, project: filter } = useSearch({ from: '/factory' });
  const navigate = useNavigate({ from: '/factory' });
  const all = projects.data ?? [];
  const shown = filter === undefined ? all : all.filter((p) => p.id === filter);
  const only = shown.length === 1 ? shown[0] : undefined;

  function setFilter(project: ProjectId | null): void {
    void navigate({
      search: (prev) => ({
        ...(prev.goal === undefined ? {} : { goal: prev.goal }),
        ...(project === null ? {} : { project }),
      }),
    });
  }

  return (
    <Stack>
      <Group justify="space-between" align="flex-start">
        <Stack gap={2}>
          <Group gap="md">
            <Title order={2}>Factory</Title>
            <BenchmarkSyncNote />
          </Group>
          <UpdateDrainNote />
          <Text size="sm" c="dimmed">
            Goals 10db is pursuing, by project
          </Text>
        </Stack>
        <ProjectFilter projects={all} value={filter ?? null} onChange={setFilter} />
      </Group>
      {projects.isError ? (
        <Alert color="red" title="Couldn't load the projects">
          {projects.error.message}
        </Alert>
      ) : null}
      {shown.map((project) => (
        <ProjectGoals key={project.id} project={project} linkedGoalId={linkedGoalId} />
      ))}
      {only ? (
        <HumanTouchPanel projectId={only.id} />
      ) : shown.length > 1 ? (
        <Text size="sm" c="dimmed">
          Choose a project to see how often a person was needed in it.
        </Text>
      ) : null}
    </Stack>
  );
}

/**
 * The project's pass while it holds pages (Workbench spec §4.1): its name and how many pages wait on
 * the builder, opening the Workbench. The group selects the project before the click lands.
 */
function ProjectPassLine({ projectId }: { readonly projectId: ProjectId }) {
  const live = useLivePass(projectId).data;
  const inbox = useInbox().data ?? [];
  const now = useNow();
  const navigate = useNavigate();
  if (live == null || !passHoldsTasks(live.pass.state)) return null;
  return (
    <PassLine
      view={live}
      inbox={inbox}
      now={now}
      onOpen={() => {
        void navigate({ to: '/workbench' });
      }}
    />
  );
}

/**
 * One project's goals under its name. Acting on anything in it makes that project the selected one
 * first, so a link into the Board or Plan opens in the project the goal belongs to.
 */
function ProjectGoals({
  project,
  linkedGoalId,
}: {
  readonly project: ProjectViewDto;
  readonly linkedGoalId: GoalId | undefined;
}) {
  const { select } = useSelectedProject();
  const goals = useGoals(project.id);
  const headingId = useId();
  return (
    // Capture runs before the click reaches a link or row, so the project is chosen before it navigates.
    <Box
      role="group"
      aria-labelledby={headingId}
      onClickCapture={() => {
        select(project.id);
      }}
    >
      <Stack gap="xs">
        <Group justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <ProjectTile name={project.name} />
            <Title order={3} size="h4" id={headingId}>
              {project.name}
            </Title>
          </Group>
          {/* Plan Work opens a new conversation in this project (Shape spec §4). */}
          <Button component={Link} to="/shape" variant="default" size="xs">
            Plan Work
          </Button>
        </Group>
        <ProjectPassLine projectId={project.id} />
        {goals.isError ? (
          <Alert color="red" title="Couldn't load the goals">
            {goals.error.message}
          </Alert>
        ) : null}
        {goals.isLoading ? <Loader size="sm" aria-label="Loading goals" /> : null}
        {goals.isSuccess && goals.data.goals.length === 0 ? (
          <Text size="sm" c="dimmed">
            Goals are outcomes 10db pursues across many tasks. Plan Work to start one, or ask Claude
            Code to with the 10db-task skill.
          </Text>
        ) : null}
        {goals.isSuccess ? (
          <GoalList project={project} list={goals.data} linkedGoalId={linkedGoalId} />
        ) : null}
      </Stack>
    </Box>
  );
}
