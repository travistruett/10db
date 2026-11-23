import type { ProjectDto } from '@10db/contracts';
import { Alert, Button, Checkbox, Group, Stack, Textarea, TextInput } from '@mantine/core';
import { useState } from 'react';
import { SurfaceDrawer } from '../../shell/surface-drawer';
import { AreaRoleFields } from './area-role-fields';
import { areaDraft, areaOf, EMPTY_AREA, lines, type AreaDraft } from './area-drafts';
import { HelpHint } from './help-hint';
import { PathMeanings } from './table-cells';
import { useListPatch } from './use-list-patch';

type StoredArea = ProjectDto['areas'][number];

/**
 * An area to change, or a new one when `area` is null. Save sends the project's whole area list with
 * only this one changed; a refusal's words stay in the drawer.
 */
export function AreaDrawer({
  project,
  area,
  onClose,
}: {
  readonly project: ProjectDto;
  readonly area: StoredArea | null;
  readonly onClose: () => void;
}) {
  const [draft, setDraft] = useState<AreaDraft>(() =>
    area === null ? EMPTY_AREA : areaDraft(area),
  );
  const { save, saving, problem } = useListPatch(project);
  const [gone, setGone] = useState(false);
  const change = (next: Partial<AreaDraft>) => {
    setDraft((d) => ({ ...d, ...next }));
  };
  const submit = () => {
    const next = areaOf(draft);
    // A catch-all is the only one, so choosing it here lets go of the old one.
    const others = project.areas.map((a) =>
      next.catchAll === true && a.catchAll === true ? { ...a, catchAll: false } : a,
    );
    const index = area === null ? -1 : project.areas.findIndex((a) => a.name === area.name);
    if (area !== null && index < 0) {
      setGone(true);
      return;
    }
    setGone(false);
    save(
      {
        areas: area === null ? [...others, next] : others.map((a, i) => (i === index ? next : a)),
      },
      onClose,
    );
  };
  return (
    <SurfaceDrawer
      opened
      onClose={onClose}
      label={area === null ? 'Add Area' : `Area ${area.name}`}
      closeOnClickOutside
    >
      <Stack gap="md">
        <TextInput
          label="Name"
          aria-label="Area name"
          placeholder="name"
          data-autofocus
          value={draft.name}
          onChange={(e) => {
            change({ name: e.currentTarget.value });
          }}
        />
        <Textarea
          label="Paths"
          aria-label="Area paths"
          placeholder="src/api/**"
          description="One pattern per line"
          autosize
          minRows={2}
          value={draft.paths}
          onChange={(e) => {
            change({ paths: e.currentTarget.value });
          }}
        />
        <PathMeanings paths={lines(draft.paths)} />
        <Group gap={4} wrap="nowrap">
          <Checkbox
            aria-label="Area is the catch-all"
            label="Catch-All"
            checked={draft.catchAll}
            onChange={(e) => {
              change({ catchAll: e.currentTarget.checked });
            }}
          />
          <HelpHint label="Catch-All">
            Holds every file no other area holds, such as a new package, app or folder, so a task
            that adds one can still change it. A file another area holds is never in the catch-all.
            Only one area can be.
          </HelpHint>
        </Group>
        <AreaRoleFields
          index={1}
          name={draft.name}
          role={draft.role}
          route={draft.route}
          label={draft.label}
          onChange={change}
        />
        {gone ? (
          <Alert color="yellow" title="This area changed">
            It was renamed or removed while this was open. Close this and open it again.
          </Alert>
        ) : null}
        {problem ? (
          <Alert color="red" title="Couldn't save the area">
            {problem}
          </Alert>
        ) : null}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={saving} onClick={submit}>
            {area === null ? 'Add Area' : 'Save Area'}
          </Button>
        </Group>
      </Stack>
    </SurfaceDrawer>
  );
}
