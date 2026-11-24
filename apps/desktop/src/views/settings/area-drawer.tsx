import type { ProjectDto } from '@10db/contracts';
import { Alert, Button, Stack, Switch, Textarea, TextInput } from '@mantine/core';
import { useEffect, useState } from 'react';
import { SurfaceDrawer } from '../../shell/surface-drawer';
import { AreaKindField } from './area-kind-field';
import { areaDraft, areaOf, EMPTY_AREA, lines, type AreaDraft } from './list-drafts';
import { ChangedAlert, PathMeanings } from './table-cells';
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
  onDirty,
}: {
  readonly project: ProjectDto;
  readonly area: StoredArea | null;
  readonly onClose: () => void;
  /** Told whether the draft differs from the row as it was opened. */
  readonly onDirty: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = useState<AreaDraft>(() =>
    area === null ? EMPTY_AREA : areaDraft(area),
  );
  const { save, saving, problem, clear } = useListPatch(project);
  const [gone, setGone] = useState(false);
  // The row as it was when the drawer opened (or last showed the latest); a save is refused when it differs.
  const [base, setBase] = useState(area);
  const [changed, setChanged] = useState(false);
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(base === null ? EMPTY_AREA : areaDraft(base));
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  useEffect(
    () => () => {
      onDirty(false);
    },
    [onDirty],
  );
  const change = (next: Partial<AreaDraft>) => {
    clear();
    setDraft((d) => ({ ...d, ...next }));
  };
  const submit = () => {
    const next = areaOf(draft);
    // A catch-all is the only one, so choosing it here lets go of the old one.
    const others = project.areas.map((a) =>
      next.catchAll === true && a.catchAll === true ? { ...a, catchAll: false } : a,
    );
    const index = base === null ? -1 : project.areas.findIndex((x) => x.name === base.name);
    if (base !== null && index < 0) {
      setGone(true);
      return;
    }
    const current = project.areas[index];
    if (base !== null && JSON.stringify(current) !== JSON.stringify(base)) {
      setChanged(true);
      return;
    }
    setGone(false);
    setChanged(false);
    save(
      {
        areas: area === null ? [...others, next] : others.map((a, i) => (i === index ? next : a)),
      },
      onClose,
      next.name,
    );
  };
  const showLatest = () => {
    const current = project.areas.find((x) => x.name === base?.name);
    if (current === undefined) return;
    clear();
    setBase(current);
    setDraft(areaDraft(current));
    setChanged(false);
  };
  return (
    <SurfaceDrawer
      opened
      onClose={onClose}
      label={area === null ? 'Add Area' : `Area ${area.name}`}
      title={area === null ? 'Add Area' : area.name}
      closeOnClickOutside
      footer={
        <>
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={saving} onClick={submit}>
            {area === null ? 'Add Area' : 'Save Area'}
          </Button>
        </>
      }
    >
      <Stack gap="lg">
        <TextInput
          label="Name"
          description="What tasks call this area."
          aria-label="Area name"
          placeholder="backend"
          data-autofocus
          value={draft.name}
          onChange={(e) => {
            change({ name: e.currentTarget.value });
          }}
        />
        <Stack gap={6}>
          <Textarea
            label="Paths"
            aria-label="Area paths"
            placeholder={'apps/api/**\napps/api/.*'}
            description="The files it holds, one pattern per line."
            autosize
            minRows={3}
            styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
            value={draft.paths}
            onChange={(e) => {
              change({ paths: e.currentTarget.value });
            }}
          />
          <PathMeanings paths={lines(draft.paths)} />
        </Stack>
        <AreaKindField
          name={draft.name}
          role={draft.role}
          route={draft.route}
          label={draft.label}
          onChange={change}
        />
        <Switch
          aria-label="Area is the catch-all"
          label="Catch-All"
          description="Also holds every file no other area holds, such as a new app or folder. Only one area can."
          checked={draft.catchAll}
          onChange={(e) => {
            change({ catchAll: e.currentTarget.checked });
          }}
        />
        {changed ? <ChangedAlert noun="area" onShowLatest={showLatest} /> : null}
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
      </Stack>
    </SurfaceDrawer>
  );
}
