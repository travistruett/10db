import {
  AreaRole,
  setupAreasProblem,
  withoutPages,
  type ProjectViewDto,
  type SettingField,
} from '@10db/contracts';
import { Anchor, Button, Checkbox, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { setupKeys, useWorkbenchSetup } from '../../../daemon/pass-queries';
import { usePatchProject } from '../../../daemon/queries';
import { SettingsSectionKey } from '../../settings/sections';
import { AreasSection } from './areas-section';
import { BranchSection } from './branch-section';
import { SettingsSection } from './settings-section';
import { areasChanged, areasSummary, setupPatch } from './setup-rules';

function SettingsLink() {
  return (
    <Anchor
      size="sm"
      renderRoot={(props) => (
        <Link {...props} to="/settings/$section" params={{ section: SettingsSectionKey.Areas }} />
      )}
    >
      Settings › Areas and hazards
    </Anchor>
  );
}

export interface WorkbenchSetupProps {
  readonly project: ProjectViewDto;
  /** Back to the picker, offered when the project has pages already. */
  readonly onBack?: () => void;
  /** Called once Apply has saved the project. */
  readonly onApplied?: () => void;
}

/**
 * The Workbench setup: 10db read the repository and proposes the project's areas rebuilt
 * with a page per route, and the settings a pass wants; the builder unticks what they don't want and
 * saves it all with one Apply, a single `PATCH /projects/:id`.
 */
export function WorkbenchSetup({ project, onBack, onApplied }: WorkbenchSetupProps) {
  const read = useWorkbenchSetup(project.id);
  const queryClient = useQueryClient();
  const apply = usePatchProject(project.id);
  const [unticked, setUnticked] = useState<readonly string[]>([]);
  const [untickedSettings, setUntickedSettings] = useState<readonly SettingField[]>([]);
  // A first setup rebuilds the areas by default; once the project has pages, rebuilding is opt-in.
  const hasPages = project.areas.some((area) => area.role === AreaRole.Page);
  const [rebuild, setRebuild] = useState(!hasPages);
  const back =
    onBack === undefined ? null : (
      <Button variant="default" onClick={onBack}>
        Back to Pages
      </Button>
    );
  const heading = (
    <>
      <Title order={2}>{`Set up ${project.name} for the Workbench`}</Title>
      <Text>
        Work through pages with the agents, live. 10db read the repository and suggests what
        follows; untick anything you don&apos;t want.
      </Text>
    </>
  );

  if (read.isPending)
    return (
      <Stack gap="md" maw={720}>
        {heading}
        <Group gap="sm">
          <Loader size="sm" />
          <Text size="sm" c="dimmed" role="status">
            Reading the repository…
          </Text>
        </Group>
      </Stack>
    );
  if (read.isError)
    return (
      <Stack gap="md" maw={720}>
        {heading}
        <Text size="sm" c="red" role="alert">
          {`The setup could not be read: ${read.error.message}`}
        </Text>
        <Group gap="md">
          <Button
            variant="default"
            onClick={() => {
              void read.refetch();
            }}
          >
            Try Again
          </Button>
          <SettingsLink />
          {back}
        </Group>
      </Stack>
    );

  const setup = read.data;
  const tickedSettings = setup.settings
    .map((s) => s.field)
    .filter((field) => !untickedSettings.includes(field));
  const result = withoutPages(setup.areas.proposed, unticked, setup.areas.pages);
  // A rebuild that changes nothing is not offered: no Areas section, Apply for settings alone.
  const offered = areasChanged(setup.areas.proposed, project.areas);
  const areasOn = offered && rebuild;
  const changed = areasOn && areasChanged(result, project.areas);
  if (!offered && setup.settings.length === 0 && setup.branch === null)
    return (
      <Stack gap="md" maw={720}>
        {heading}
        <Text size="sm">Nothing to set up.</Text>
        <Group gap="md">
          <SettingsLink />
          {back}
        </Group>
      </Stack>
    );

  const problem = changed
    ? setupAreasProblem(
        result,
        project.hazards.map((h) => h.name),
      )
    : null;
  const body = setupPatch(setup, project.areas, unticked, tickedSettings, areasOn);
  const pagesTicked = setup.areas.pages.length - unticked.length;
  const count = (areasOn ? Math.max(pagesTicked, 1) : 0) + tickedSettings.length;
  const toggle = <T,>(list: readonly T[], item: T, ticked: boolean): readonly T[] =>
    ticked ? list.filter((x) => x !== item) : [...list, item];
  return (
    <Stack gap="lg" maw={720}>
      {heading}
      {!offered ? null : (
        <Stack gap="sm">
          {hasPages ? (
            <Checkbox
              checked={rebuild}
              onChange={(event) => {
                setRebuild(event.currentTarget.checked);
              }}
              label={`Rebuild areas: ${String(setup.areas.pages.length)} new ${
                setup.areas.pages.length === 1 ? 'page' : 'pages'
              }, ${areasSummary(project.areas, result)}`}
            />
          ) : null}
          {areasOn ? (
            <AreasSection
              project={project}
              areas={setup.areas}
              result={result}
              unticked={unticked}
              onTick={(page, ticked) => {
                setUnticked((list) => toggle(list, page, ticked));
              }}
            />
          ) : null}
        </Stack>
      )}
      {setup.settings.length === 0 ? null : (
        <SettingsSection
          settings={setup.settings}
          ticked={tickedSettings}
          onTick={(field, ticked) => {
            setUntickedSettings((list) => toggle(list, field, ticked));
          }}
        />
      )}
      {setup.branch === null ? null : <BranchSection branch={setup.branch} />}
      <Stack gap="xs">
        {problem === null && apply.error === null ? null : (
          <Text size="sm" c="red" role="alert">
            {problem ?? apply.error?.message}
          </Text>
        )}
        <Group justify="flex-end" gap="sm">
          {back}
          <Button
            disabled={body === null || problem !== null}
            loading={apply.isPending}
            onClick={() => {
              if (body === null) return;
              apply.mutate(body, {
                onSuccess: () => {
                  void queryClient.invalidateQueries({ queryKey: setupKeys.of(project.id) });
                  onApplied?.();
                },
              });
            }}
          >
            {`Apply (${String(count)})`}
          </Button>
        </Group>
      </Stack>
    </Stack>
  );
}
