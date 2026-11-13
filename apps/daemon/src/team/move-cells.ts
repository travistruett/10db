import {
  RIGORS,
  StepRole,
  type CellSetting,
  type Effort,
  type FlowDto,
  type ModelSetting,
  type PlaybookInput,
  type ProjectId,
  type Rigor,
  type RoleSettingDto,
} from '@10db/contracts';
import type { LegacyBinding, LegacyPersona, LegacyRouting } from '@10db/db';
import { DEFAULT_CELLS, DEFAULT_PERSONA_FOR, ROLE_DEFAULT } from '../routing';
import { describeSetting, type ScopedMoveEntry } from './move-entries';
import { rigorOfFlow } from './move-rigor';

const ROLES: readonly StepRole[] = Object.values(StepRole);

type Draft = Map<string, CellSetting>;
const keyOf = (rigor: Rigor, role: StepRole): string => `${rigor}/${role}`;
const NONE: CellSetting = { personaId: null, model: null, effort: null };

function sameModel(a: ModelSetting | null, b: ModelSetting | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function inputOf(draft: Draft): PlaybookInput {
  const cells = RIGORS.flatMap((rigor) =>
    ROLES.flatMap((role) => {
      const cell = draft.get(keyOf(rigor, role));
      return cell && (cell.personaId !== null || cell.model !== null || cell.effort !== null)
        ? [{ rigor, role, ...cell }]
        : [];
    }),
  );
  return { rows: [], cells };
}

/** The setting raised to a persona's minimum score, or null when it has none to raise: only automatic carries one. */
function raisedTo(model: ModelSetting | null, minimum: number | null): ModelSetting | null {
  if (model?.kind !== 'automatic' || minimum === null) return null;
  return (model.minimum ?? 0) < minimum ? { kind: 'automatic', minimum } : null;
}

/** A persona with a minimum a non-automatic setting cannot carry, for the report. */
function minimumLost(
  persona: LegacyPersona | undefined,
  base: ModelSetting | null,
): persona is LegacyPersona {
  return (
    persona?.modelPin === null &&
    persona.minimumScore !== null &&
    base !== null &&
    base.kind !== 'automatic'
  );
}

export interface MovedCells {
  readonly global: PlaybookInput;
  readonly projects: readonly { readonly projectId: ProjectId; readonly input: PlaybookInput }[];
  readonly entries: readonly ScopedMoveEntry[];
}

/**
 * The cells today's role settings, team bindings, persona pins and minimums, and flow-step personas make.
 * A persona's pin beats every role setting at every scope, as it did; the persona that fills a role is the
 * project's binding, else the default persona. A project cell is written only where it says something the
 * global cell would not, so a global pin never reaches a project whose persona has none.
 */
export function moveCells(legacy: LegacyRouting): MovedCells {
  const live = legacy.personas.filter((p) => !p.archived);
  const defaultPersona = (role: StepRole): LegacyPersona | undefined =>
    live.find((p) => p.key === DEFAULT_PERSONA_FOR[role]) ?? live.find((p) => p.role === role);
  const roleSetting = (role: StepRole, projectId: ProjectId | null): ModelSetting | null =>
    legacy.roleSettings.find((r: RoleSettingDto) => r.role === role && r.projectId === projectId)
      ?.setting ?? null;
  const entries: ScopedMoveEntry[] = [];
  const global: Draft = new Map();

  for (const role of ROLES) {
    const persona = defaultPersona(role);
    const pin = persona?.modelPin ?? null;
    const own = roleSetting(role, null);
    if (!pin && minimumLost(persona, own)) entries.push(minimumEntry(persona, own, null));
    for (const rigor of RIGORS) {
      const base = own ?? DEFAULT_CELLS[rigor][role]?.model ?? null;
      const raised = pin ? null : raisedTo(base, persona?.minimumScore ?? null);
      global.set(keyOf(rigor, role), {
        personaId: null,
        model: pin ? { kind: 'model', model: pin.model } : (raised ?? own),
        effort: pin?.effort ?? null,
      });
    }
  }

  for (const flow of [...legacy.flows].sort((a, b) => a.name.localeCompare(b.name))) {
    const rigor = rigorOfFlow(flow);
    for (const step of flow.steps) {
      if (step.persona === null) continue;
      const persona = live.find((p) => p.key === step.persona && p.role === step.role);
      if (!persona) continue;
      const cell = global.get(keyOf(rigor, step.role)) ?? NONE;
      if (cell.personaId === null)
        global.set(keyOf(rigor, step.role), { ...cell, personaId: persona.id });
      else if (cell.personaId !== persona.id) entries.push(collision(flow, step.role, persona.key));
    }
  }

  const modelOf = (rigor: Rigor, role: StepRole): ModelSetting | null =>
    global.get(keyOf(rigor, role))?.model ?? DEFAULT_CELLS[rigor][role]?.model ?? null;

  const projects = legacy.projects.flatMap((project) => {
    const draft: Draft = new Map();
    for (const role of ROLES) {
      const binding = legacy.bindings.find(
        (b: LegacyBinding) => b.projectId === project.id && b.role === role,
      );
      const bound = binding ? live.find((p) => p.id === binding.personaId) : undefined;
      const fills = bound ?? defaultPersona(role);
      const pin = fills?.modelPin ?? null;
      const defaultPin = defaultPersona(role)?.modelPin ?? null;
      const own = roleSetting(role, project.id);
      const inherited = roleSetting(role, null);
      if (
        !pin &&
        minimumLost(fills, own ?? inherited) &&
        (fills.id !== defaultPersona(role)?.id || own !== null)
      )
        entries.push(minimumEntry(fills, own ?? inherited, project.id));
      for (const rigor of RIGORS) {
        const base = own ?? inherited ?? DEFAULT_CELLS[rigor][role]?.model ?? null;
        const final: ModelSetting | null = pin
          ? { kind: 'model', model: pin.model }
          : (raisedTo(base, fills?.minimumScore ?? null) ?? base);
        const effort: Effort | null = pin
          ? pin.effort
          : defaultPin
            ? ROLE_DEFAULT[role].effort
            : null;
        const explicit = own !== null && !pin;
        const writeModel = final !== null && (explicit || !sameModel(final, modelOf(rigor, role)));
        const writeEffort =
          effort !== null && effort !== (global.get(keyOf(rigor, role))?.effort ?? null);
        draft.set(keyOf(rigor, role), {
          personaId: bound?.id ?? null,
          model: writeModel ? final : null,
          effort: writeEffort ? effort : null,
        });
      }
    }
    const input = inputOf(draft);
    return input.cells && input.cells.length > 0 ? [{ projectId: project.id, input }] : [];
  });

  return { global: inputOf(global), projects, entries };
}

function minimumEntry(
  persona: LegacyPersona,
  base: ModelSetting | null,
  projectId: ProjectId | null,
): ScopedMoveEntry {
  return {
    projectId,
    setting: `Minimum score of the ${persona.key} persona`,
    value: `${String(persona.minimumScore)}, on ${base ? describeSetting(base) : 'no setting'}`,
    why: 'Only an automatic model can carry a minimum score; a tier or one model has none to raise',
  };
}

function collision(flow: FlowDto, role: StepRole, personaKey: string): ScopedMoveEntry {
  return {
    projectId: null,
    setting: `Persona of the ${role} step in the flow ${flow.name}`,
    value: personaKey,
    why: 'Another flow at the same rigor names a different persona for this step, and the first stays',
  };
}
