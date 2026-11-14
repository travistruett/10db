import type { ModelSetting, StepRole, TaskId } from '@10db/contracts';
import {
  findPersonaByKey,
  insertPersona,
  insertTask,
  patchTask,
  readLegacyRouting,
  seedProject,
  type LegacyRiskTag,
  type Store,
} from '@10db/db';
import {
  seedLegacyBinding,
  seedLegacyDefaultFlows,
  seedLegacyPatterns,
  seedLegacyPersonaPin,
  seedLegacyRoleSetting,
  seedLegacyTaskRouting,
} from './legacy-rows';
import type { StateStore } from '../src/events';

export interface MovedTask {
  readonly name: string;
  readonly flow: 'quick' | 'standard' | 'full';
  readonly criteria: number;
  readonly tag: LegacyRiskTag | null;
}

export const MOVED_TASKS: readonly MovedTask[] = [
  { name: 'quick', flow: 'quick', criteria: 1, tag: null },
  { name: 'standard', flow: 'standard', criteria: 1, tag: null },
  { name: 'standard+dependency', flow: 'standard', criteria: 1, tag: 'dependency' },
  { name: 'full(4)', flow: 'full', criteria: 4, tag: null },
];

const OPUS = 'claude-opus-5-5';
const FABLE = 'claude-fable-5-1';
const tier = (t: 'efficient' | 'balanced' | 'capable' | 'frontier'): ModelSetting => ({
  kind: 'tier',
  tier: t,
});

type Setup = (h: Helpers) => void;
interface Helpers {
  setting(role: StepRole, project: boolean, value: ModelSetting): void;
  pin(key: string, pin: { model: string; effort: 'low' | 'medium' | 'high' }): void;
  minimum(key: string, score: number): void;
  bind(role: StepRole, key: string): void;
  persona(
    key: string,
    role: StepRole,
    pin?: { model: string; effort: 'low' | 'medium' | 'high' },
  ): void;
  pattern(roles: StepRole[], tags: LegacyRiskTag[], value: ModelSetting): void;
  /** Gives every task of the world a model setting of its own. */
  taskModel(value: ModelSetting): void;
}

export const MOVED_SCENARIOS: Readonly<Record<string, Setup>> = {
  'global review tier frontier': (h) => {
    h.setting('review', false, tier('frontier'));
  },
  'global implement one model': (h) => {
    h.setting('implement', false, { kind: 'model', model: OPUS });
  },
  'pin beats the implement setting': (h) => {
    h.setting('implement', false, tier('balanced'));
    h.pin('implementer', { model: OPUS, effort: 'low' });
  },
  'bound persona with a pin, global review capable': (h) => {
    h.setting('review', false, tier('capable'));
    h.persona('deep-reviewer', 'review', { model: FABLE, effort: 'medium' });
    h.bind('review', 'deep-reviewer');
  },
  'project implement top of tier': (h) => {
    h.setting('implement', true, { kind: 'top_of_tier' });
  },
  'project review one tier up, global review tier': (h) => {
    h.setting('review', false, tier('balanced'));
    h.setting('review', true, tier('capable'));
  },
  'global pattern: dependency review on frontier': (h) => {
    h.pattern(['review'], ['dependency'], tier('frontier'));
  },
  'implementer minimum 60': (h) => {
    h.minimum('implementer', 60);
  },
  'implementer minimum 100': (h) => {
    h.minimum('implementer', 100);
  },
  'a task’s own model and a persona pin': (h) => {
    h.pin('implementer', { model: OPUS, effort: 'low' });
    h.taskModel(tier('frontier'));
  },
};

export function buildMovedWorld(
  state: StateStore,
  store: Store,
  setup: Setup,
): { taskIds: Map<string, TaskId> } {
  const project = seedProject(store, { name: 'moved' });
  const find = (key: string) => {
    const persona = findPersonaByKey(state.db, key);
    if (!persona) throw new Error(`no persona ${key}`);
    return persona;
  };
  const pinOf = (pin: { model: string; effort: 'low' | 'medium' | 'high' }) => pin;
  let taskModel: ModelSetting | null = null;
  state.write((ctx) => {
    setup({
      setting: (role, inProject, value) => {
        seedLegacyRoleSetting(ctx, {
          role,
          projectId: inProject ? project.id : null,
          setting: value,
        });
      },
      pin: (key, pin) => {
        seedLegacyPersonaPin(ctx, find(key).id, { modelPin: pinOf(pin) });
      },
      minimum: (key, score) => {
        seedLegacyPersonaPin(ctx, find(key).id, { minimumScore: score });
      },
      bind: (role, key) => {
        seedLegacyBinding(ctx, { projectId: project.id, role, personaId: find(key).id });
      },
      persona: (key, role, pin) => {
        const made = insertPersona(ctx, {
          key,
          name: key,
          role,
          tools: role === 'implement' ? 'edit' : 'read_only',
          instructions: 'Do it.',
        });
        if (pin) seedLegacyPersonaPin(ctx, made.id, { modelPin: pin });
      },
      taskModel: (value) => {
        taskModel = value;
      },
      pattern: (roles, tags, value) => {
        seedLegacyPatterns(ctx, null, [
          { name: 'Mine', match: { roles, riskTags: tags }, setting: value },
        ]);
      },
    });
  });
  const taskIds = new Map<string, TaskId>();
  state.write((ctx) => {
    seedLegacyDefaultFlows(ctx);
    const flows = readLegacyRouting(ctx.tx).flows;
    for (const t of MOVED_TASKS) {
      const made = insertTask(ctx, project.id, {
        title: t.name,
        acceptanceCriteria: Array.from({ length: t.criteria }, (_, i) => `c${String(i)}`),
        areas: ['api'],
      });
      seedLegacyTaskRouting(ctx, made.id, {
        riskTags: t.tag === null ? [] : [t.tag],
        flowId: flows.find((f) => f.name === t.flow)?.id ?? null,
      });
      if (taskModel !== null) patchTask(ctx, made.id, { modelSetting: taskModel });
      taskIds.set(t.name, made.id);
    }
  });
  return { taskIds };
}
