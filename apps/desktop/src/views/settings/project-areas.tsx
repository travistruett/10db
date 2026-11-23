import { hazardScope, HazardScope, ProjectPatch, type ProjectDto } from '@10db/contracts';
import { Accordion, Alert, Button, Group, Stack, Text, Title } from '@mantine/core';
import { useState } from 'react';
import { usePatchProject } from '../../daemon/queries';
import { AreaRow, HazardRow, lines, type AreaDraft, type HazardDraft } from './area-rows';
import { roleFields } from './area-role-fields';
import { HazardAdditions } from './hazard-additions';
import { HelpHint } from './help-hint';

const areaDrafts = (project: ProjectDto): AreaDraft[] =>
  project.areas.map((a) => ({
    name: a.name,
    paths: a.globs.join('\n'),
    catchAll: a.catchAll === true,
    role: a.role ?? '',
    route: a.route ?? '',
    label: a.label ?? '',
  }));
const hazardDrafts = (project: ProjectDto): HazardDraft[] =>
  project.hazards.map((h) => ({
    name: h.name,
    paths: h.globs.join('\n'),
    commands: h.commands.join('\n'),
    perCopy: hazardScope(h) === HazardScope.Copy,
  }));

/** The patch for the drafts, or the first thing wrong with them. */
function toPatch(
  areas: readonly AreaDraft[],
  hazards: readonly HazardDraft[],
): { readonly patch: ProjectPatch } | { readonly error: string } {
  const parsed = ProjectPatch.safeParse({
    areas: areas.map((a) => ({
      name: a.name.trim(),
      globs: lines(a.paths),
      ...(a.catchAll ? { catchAll: true } : {}),
      ...roleFields(a.role, a.route, a.label),
    })),
    hazards: hazards.map((h) => ({
      name: h.name.trim(),
      globs: lines(h.paths),
      commands: lines(h.commands),
      scope: h.perCopy ? HazardScope.Copy : HazardScope.Project,
    })),
  });
  if (parsed.success) return { patch: parsed.data };
  const issue = parsed.error.issues[0];
  const [list, index, field] = issue?.path ?? [];
  const where =
    typeof index === 'number' && (list === 'areas' || list === 'hazards')
      ? `${list === 'areas' ? 'Area' : 'Hazard'} ${String(index + 1)}${field === 'globs' ? ' paths' : field === 'name' ? ' name' : field === 'route' ? ' route' : field === 'label' ? ' label' : ''}`
      : 'Areas and Hazards';
  return { error: `${where}: ${issue?.message ?? 'is not valid'}` };
}

/** Add, rename, remove and edit the project's areas and hazards, saved in one patch to the project. */
export function ProjectAreas({ project }: { readonly project: ProjectDto }) {
  const patch = usePatchProject(project.id);
  const [areas, setAreas] = useState(() => areaDrafts(project));
  const [hazards, setHazards] = useState(() => hazardDrafts(project));
  const [problem, setProblem] = useState<string | null>(null);
  const [openAreas, setOpenAreas] = useState<string[]>([]);
  const [openHazards, setOpenHazards] = useState<string[]>([]);
  // 10db adds to the hazards by itself, so the project can change while this page is open. Drafts the
  // builder has not touched follow it; edited ones stay, with a note that Save would replace the change.
  const stored = JSON.stringify([areaDrafts(project), hazardDrafts(project)]);
  const [seen, setSeen] = useState(stored);
  const [outdated, setOutdated] = useState(false);
  if (stored !== seen) {
    setSeen(stored);
    const current = JSON.stringify([areas, hazards]);
    if (current === seen) {
      setAreas(areaDrafts(project));
      setHazards(hazardDrafts(project));
    } else if (current !== stored) {
      setOutdated(true);
    }
  }
  const changed = JSON.stringify([areas, hazards]) !== stored;

  const save = () => {
    const result = toPatch(areas, hazards);
    if ('error' in result) {
      setProblem(result.error);
      return;
    }
    setProblem(null);
    setOutdated(false);
    patch.mutate(result.patch);
  };
  const setArea = (index: number, next: Partial<AreaDraft>) => {
    setAreas((all) => all.map((a, i) => (i === index ? { ...a, ...next } : a)));
  };
  /** Only one area is the catch-all, so choosing one clears the others. */
  const setCatchAll = (index: number, catchAll: boolean) => {
    setAreas((all) =>
      all.map((a, i) =>
        i === index ? { ...a, catchAll } : catchAll ? { ...a, catchAll: false } : a,
      ),
    );
  };
  const setHazard = (index: number, next: Partial<HazardDraft>) => {
    setHazards((all) => all.map((h, i) => (i === index ? { ...h, ...next } : h)));
  };

  /** Rows that stay open after one is removed keep their place in the shifted list. */
  const afterRemoval = (open: string[], index: number): string[] =>
    open
      .filter((v) => v !== String(index))
      .map((v) => (Number(v) > index ? String(Number(v) - 1) : v));

  return (
    <Stack gap="xl">
      <Stack gap="xs">
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Stack gap={2}>
            <Group gap={4}>
              <Title order={4}>Areas</Title>
              <HelpHint label="Areas">
                <Text size="sm" mb={4}>
                  An area is a part of the project. Tasks in different areas can run at the same
                  time, and a task may change only the files of the areas it names.
                </Text>
                <Text size="sm">
                  Paths are folder patterns, one per line: <code>src/api/**</code> means everything
                  inside src/api/.
                </Text>
              </HelpHint>
            </Group>
            <Text size="sm" c="dimmed">
              The parts of the project that tasks claim.
            </Text>
          </Stack>
          <Button
            variant="default"
            onClick={() => {
              setOpenAreas((open) => [...open, String(areas.length)]);
              setAreas((all) => [
                ...all,
                { name: '', paths: '', catchAll: false, role: '', route: '', label: '' },
              ]);
            }}
          >
            Add Area
          </Button>
        </Group>
        {areas.length === 0 ? <Text c="dimmed">No areas.</Text> : null}
        <Accordion multiple variant="separated" value={openAreas} onChange={setOpenAreas}>
          {areas.map((area, index) => (
            <AreaRow
              key={index}
              index={index}
              area={area}
              onChange={(next) => {
                setArea(index, next);
              }}
              onCatchAll={(catchAll) => {
                setCatchAll(index, catchAll);
              }}
              onRemove={() => {
                setOpenAreas((open) => afterRemoval(open, index));
                setAreas((all) => all.filter((_, i) => i !== index));
              }}
            />
          ))}
        </Accordion>
      </Stack>

      <Stack gap="xs">
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Stack gap={2}>
            <Group gap={4}>
              <Title order={4}>Hazards</Title>
              <HelpHint label="Hazards">
                A hazard is a set of files only one task changes at a time, such as lockfiles or
                migrations. A task that touches one, or runs one of its commands, waits for the task
                that holds it.
              </HelpHint>
            </Group>
            <Text size="sm" c="dimmed">
              Files and commands that tasks take turns on.
            </Text>
          </Stack>
          <Button
            variant="default"
            onClick={() => {
              setOpenHazards((open) => [...open, String(hazards.length)]);
              setHazards((all) => [...all, { name: '', paths: '', commands: '', perCopy: false }]);
            }}
          >
            Add Hazard
          </Button>
        </Group>
        <HazardAdditions project={project} />
        {outdated ? (
          <Alert color="yellow" title="The hazards changed while you were editing">
            Saving now replaces what changed.{' '}
            <Button
              variant="subtle"
              size="compact-sm"
              onClick={() => {
                setAreas(areaDrafts(project));
                setHazards(hazardDrafts(project));
                setOutdated(false);
              }}
            >
              Discard My Edits and Show the Latest
            </Button>
          </Alert>
        ) : null}
        {hazards.length === 0 ? <Text c="dimmed">No hazards.</Text> : null}
        <Accordion multiple variant="separated" value={openHazards} onChange={setOpenHazards}>
          {hazards.map((hazard, index) => (
            <HazardRow
              key={index}
              index={index}
              hazard={hazard}
              onChange={(next) => {
                setHazard(index, next);
              }}
              onRemove={() => {
                setOpenHazards((open) => afterRemoval(open, index));
                setHazards((all) => all.filter((_, i) => i !== index));
              }}
            />
          ))}
        </Accordion>
      </Stack>

      {problem ? (
        <Alert color="red" title="Check the areas and hazards">
          {problem}
        </Alert>
      ) : null}
      {patch.error ? (
        <Alert color="red" title="Couldn't save the areas and hazards">
          {patch.error.message}
        </Alert>
      ) : null}
      <Group>
        <Button disabled={!changed || patch.isPending} loading={patch.isPending} onClick={save}>
          Save Areas and Hazards
        </Button>
      </Group>
    </Stack>
  );
}
