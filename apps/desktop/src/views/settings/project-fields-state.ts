import type { ProjectDto } from '@10db/contracts';
import { useEffect, useRef, useState } from 'react';
import { FIELD_HOMES } from './general-field-homes';
import { useDaemon } from '../../daemon/provider';
import { usePatchProject } from '../../daemon/queries';
import {
  checkGeneral,
  generalValues,
  type GeneralErrors,
  type GeneralValues,
} from './general-values';

/** Keeps the fields the builder changed and moves the rest to the project's current values. */
function reseed(current: GeneralValues, seed: GeneralValues, next: GeneralValues): GeneralValues {
  return {
    name: current.name === seed.name ? next.name : current.name,
    gateCommand: current.gateCommand === seed.gateCommand ? next.gateCommand : current.gateCommand,
    changedCheckCommand:
      current.changedCheckCommand === seed.changedCheckCommand
        ? next.changedCheckCommand
        : current.changedCheckCommand,
    precheckCommand:
      current.precheckCommand === seed.precheckCommand
        ? next.precheckCommand
        : current.precheckCommand,
    maxLanes: current.maxLanes === seed.maxLanes ? next.maxLanes : current.maxLanes,
    handoffPct: current.handoffPct === seed.handoffPct ? next.handoffPct : current.handoffPct,
    nudgePct: current.nudgePct === seed.nudgePct ? next.nudgePct : current.nudgePct,
    humanWaitMinutes:
      current.humanWaitMinutes === seed.humanWaitMinutes
        ? next.humanWaitMinutes
        : current.humanWaitMinutes,
    budgetCeiling:
      current.budgetCeiling === seed.budgetCeiling ? next.budgetCeiling : current.budgetCeiling,
    delivery: current.delivery === seed.delivery ? next.delivery : current.delivery,
    baseBranch: current.baseBranch === seed.baseBranch ? next.baseBranch : current.baseBranch,
    landing: current.landing === seed.landing ? next.landing : current.landing,
    landingBranch:
      current.landingBranch === seed.landingBranch ? next.landingBranch : current.landingBranch,
    prTitlePrefix:
      current.prTitlePrefix === seed.prTitlePrefix ? next.prTitlePrefix : current.prTitlePrefix,
    allowedCommands:
      current.allowedCommands === seed.allowedCommands
        ? next.allowedCommands
        : current.allowedCommands,
    sandboxLoopback:
      current.sandboxLoopback === seed.sandboxLoopback
        ? next.sandboxLoopback
        : current.sandboxLoopback,
    sandboxDocker:
      current.sandboxDocker === seed.sandboxDocker ? next.sandboxDocker : current.sandboxDocker,
    prPictures: current.prPictures === seed.prPictures ? next.prPictures : current.prPictures,
    workspaceMode:
      current.workspaceMode === seed.workspaceMode ? next.workspaceMode : current.workspaceMode,
    worktreeSeed: sameList(current.worktreeSeed, seed.worktreeSeed)
      ? next.worktreeSeed
      : current.worktreeSeed,
    isolate: sameList(current.isolate, seed.isolate) ? next.isolate : current.isolate,
    appUrl: current.appUrl === seed.appUrl ? next.appUrl : current.appUrl,
    devLoginCommand:
      current.devLoginCommand === seed.devLoginCommand
        ? next.devLoginCommand
        : current.devLoginCommand,
    previewCommand:
      current.previewCommand === seed.previewCommand ? next.previewCommand : current.previewCommand,
    screens:
      JSON.stringify(current.screens) === JSON.stringify(seed.screens)
        ? next.screens
        : current.screens,
  };
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((name, i) => name === b[i]);

export const asNumber = (value: number | string): number | '' =>
  typeof value === 'number' ? value : '';

/** The port of the daemon's address, which an app address may not name; null for one with none. */
function daemonPortOf(url: string): number | null {
  try {
    const parsed = new URL(url);
    return parsed.port === '' ? null : Number(parsed.port);
  } catch {
    return null;
  }
}

/** Monospace for the typed value only; `ff` on an input would set its label in monospace too. */
export const MONO_INPUT = { input: { fontFamily: 'var(--mantine-font-family-monospace)' } };

const isGeneralField = (name: string): name is keyof GeneralValues => name in FIELD_HOMES;

/**
 * A page's typed settings, held as one set of values and saved as one patch of what changed. Every page
 * holds the full set but shows only its own fields; a field it does not show stays at the project's value
 * and adds nothing to the patch.
 */
export function useProjectFields(project: ProjectDto, shown: readonly (keyof GeneralValues)[]) {
  const patch = usePatchProject(project.id);
  const { connection } = useDaemon();
  const [values, setValues] = useState<GeneralValues>(() => generalValues(project));
  // The values the untouched fields were last seeded from; a field still equal to its seed follows the project.
  const [seed, setSeed] = useState<GeneralValues>(() => generalValues(project));
  const [seededFrom, setSeededFrom] = useState(project);
  if (seededFrom !== project) {
    const next = generalValues(project);
    setSeededFrom(project);
    setSeed(next);
    setValues((v) => reseed(v, seed, next));
  }
  const [errors, setErrors] = useState<GeneralErrors>({});
  const [note, setNote] = useState<string | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The confirmation's timer belongs to the latest save and ends with the form.
  useEffect(
    () => () => {
      clearTimeout(savedTimer.current);
    },
    [],
  );
  const set = (change: Partial<GeneralValues>) => {
    setValues((v) => ({ ...v, ...change }));
    setNote(null);
  };

  function save() {
    const checked = checkGeneral(project, values, daemonPortOf(connection.url));
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    if (checked.patch === null) {
      setNote('Nothing to change');
      return;
    }
    patch.mutate(checked.patch, {
      onSuccess: () => {
        setNote('Saved');
        // The confirmation fades after a moment; a later edit clears it at once.
        clearTimeout(savedTimer.current);
        savedTimer.current = setTimeout(() => {
          setNote((current) => (current === 'Saved' ? null : current));
        }, 4000);
      },
    });
  }

  function reset() {
    setValues(generalValues(project));
    setErrors({});
    setNote(null);
  }

  // A field the page does not show can still fail a check; Save then needs to say where it is.
  const hiddenField = Object.keys(errors).find(
    (name): name is keyof GeneralValues => isGeneralField(name) && !shown.includes(name),
  );
  const dirty = JSON.stringify(values) !== JSON.stringify(generalValues(project));

  return {
    values,
    errors,
    dirty,
    hiddenField: hiddenField ?? null,
    note,
    set,
    save,
    reset,
    saving: patch.isPending,
    saveError: patch.error ? patch.error.message : null,
  };
}
