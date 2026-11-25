import { AreaRole, setupAreasProblem, type ProjectDto, type SettingField } from '@10db/contracts';
import { EmptyState } from '../../../shell/empty-state';
import { TitleRow } from '../../../shell/title-row';
import { Anchor, Button, Checkbox, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { IconMap2, IconTools } from '@tabler/icons-react';
import { useState } from 'react';
import { setupKeys, useWorkbenchSetup } from '../../../daemon/pass-queries';
import { usePatchProject } from '../../../daemon/queries';
import { SettingsSectionKey } from '../../settings/sections';
import { AreasSection, PageRows, SplitRows } from './areas-section';
import { settingDrafts, settingsPatch, type SettingDraft } from './setting-drafts';
import { SettingRows, type SettingChange } from './setting-rows';
import { areasAfter, areasChanged, newPagesOf, setupPatch } from './setup-rules';
import { CONTENT_WIDTH_PX, ContentWidth } from '../../../shell/content-width';

function SettingsLink() {
  return (
    <Anchor
      size="sm"
      renderRoot={(props) => (
        <Link {...props} to="/settings/$section" params={{ section: SettingsSectionKey.Areas }} />
      )}
    >
      Settings › Areas and Hazards
    </Anchor>
  );
}

export interface WorkbenchSetupProps {
  readonly project: ProjectDto;
  /** Closes the modal unsaved; given only in the modal, which holds the title. */
  readonly onCancel?: () => void;
  /** Called once Apply has saved the project. */
  readonly onApplied?: () => void;
}

/**
 * The Workbench setup: 10db read the repository and proposes the project's areas rebuilt
 * with a page per route, and the settings a pass wants; the builder unticks what they don't want and
 * saves it all with one Apply, a single `PATCH /projects/:id`.
 */
export function WorkbenchSetup({ project, onCancel, onApplied }: WorkbenchSetupProps) {
  const read = useWorkbenchSetup(project.id);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const apply = usePatchProject(project.id);
  // The builder's ticks on the new pages, over the default that a page left out before starts unticked.
  const [tickEdits, setTickEdits] = useState<Readonly<Record<string, boolean>>>({});
  // The builder's ticks and edits by field, over the suggestions as the daemon gave them.
  const [settingEdits, setSettingEdits] = useState<Partial<Record<SettingField, SettingChange>>>(
    {},
  );
  // A first setup rebuilds the areas by default, and so does one that found a page not yet left out;
  // otherwise, once the project has pages, rebuilding is opt-in.
  const hasPages = project.areas.some((area) => area.role === AreaRole.Page);
  const [rebuildEdit, setRebuildEdit] = useState<boolean | null>(null);
  const back =
    onCancel === undefined ? null : (
      <Button variant="default" onClick={onCancel}>
        Cancel
      </Button>
    );
  const heading =
    onCancel === undefined ? (
      <>
        <TitleRow title={`Set up ${project.name} for the UI Workbench`} />
        <Text>
          Work through pages with the agents, live. 10db read the repository and suggests what
          follows; untick anything you don&apos;t want.
        </Text>
      </>
    ) : (
      <Text size="sm">
        10db read the repository and suggests what follows; untick anything you don&apos;t want.
      </Text>
    );

  if (read.isPending)
    return (
      <Stack gap="md" w="100%" maw={CONTENT_WIDTH_PX[ContentWidth.Reading]} mx="auto">
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
      <Stack gap="md" w="100%" maw={CONTENT_WIDTH_PX[ContentWidth.Reading]} mx="auto">
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
  const ticked = (name: string) => tickEdits[name] ?? !project.leftOutPages.includes(name);
  const unticked = [
    ...setup.areas.pages.map((page) => page.name),
    ...setup.areas.splits.map((row) => row.from),
  ].filter((name) => !ticked(name));
  const rebuild = rebuildEdit ?? (!hasPages || newPagesOf(setup, project.leftOutPages).length > 0);
  const drafts: SettingDraft[] = settingDrafts(setup.settings).map((d) => ({
    ...d,
    ...settingEdits[d.field],
  }));
  // A rebuild that changes nothing is not offered: no rebuild line, Apply for splits and settings alone.
  const rebuildOffered = areasChanged(setup.areas.proposed, project.areas);
  const splits = setup.areas.splits;
  const offered = rebuildOffered || splits.length > 0;
  const areasOn = rebuildOffered && rebuild;
  const result = areasAfter(setup, project.areas, unticked, areasOn);
  const changed = areasChanged(result, project.areas);
  const onTick = (name: string, on: boolean) => {
    setTickEdits((edits) => ({ ...edits, [name]: on }));
  };
  if (!offered && setup.settings.length === 0)
    return (
      <Stack gap="md">
        {onCancel === undefined ? <TitleRow title="UI Workbench" /> : null}
        <EmptyState
          icon={IconTools}
          title="No pages found"
          action={{
            label: 'Open Areas and Hazards',
            icon: IconMap2,
            onClick: () => {
              void navigate({
                to: '/settings/$section',
                params: { section: SettingsSectionKey.Areas },
              });
            },
          }}
        >
          {`10db read ${project.name} and found no routes to work through. A page is an area with a route.`}
        </EmptyState>
        {back === null ? null : <Group justify="flex-end">{back}</Group>}
      </Stack>
    );

  const problem = changed
    ? setupAreasProblem(
        result,
        project.hazards.map((h) => h.name),
      )
    : null;
  const body = setupPatch(
    setup,
    project.areas,
    unticked,
    settingsPatch(drafts),
    areasOn,
    project.leftOutPages,
  );
  return (
    <Stack gap="lg" w="100%" maw={CONTENT_WIDTH_PX[ContentWidth.Reading]} mx="auto">
      {heading}
      {!offered ? null : (
        <Stack gap="sm">
          {hasPages && rebuildOffered ? (
            <Checkbox
              checked={rebuild}
              onChange={(event) => {
                setRebuildEdit(event.currentTarget.checked);
              }}
              label={`Rebuild areas: ${String(setup.areas.pages.length)} new ${
                setup.areas.pages.length === 1 ? 'page' : 'pages'
              }, ${String(project.areas.length)} → ${String(result.length)} ${result.length === 1 ? 'area' : 'areas'}`}
            />
          ) : null}
          {areasOn ? (
            <AreasSection
              project={project}
              areas={setup.areas}
              result={result}
              unticked={unticked}
              onTick={onTick}
              summarized={hasPages}
            />
          ) : (
            // Leaving a page out, or splitting an area, needs no rebuild: Apply remembers the rows.
            <>
              <PageRows pages={setup.areas.pages} unticked={unticked} onTick={onTick} />
              <SplitRows splits={splits} unticked={unticked} onTick={onTick} />
            </>
          )}
        </Stack>
      )}
      {drafts.length === 0 ? null : (
        <Stack gap="sm" component="section" aria-label="Settings">
          <Title order={3}>Settings</Title>
          <SettingRows
            drafts={drafts}
            onChange={(field, change) => {
              setSettingEdits((edits) => ({ ...edits, [field]: { ...edits[field], ...change } }));
            }}
          />
        </Stack>
      )}
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
            Apply
          </Button>
        </Group>
      </Stack>
    </Stack>
  );
}
