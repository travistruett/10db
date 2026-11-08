import {
  DEFAULT_HAZARDS,
  HazardEntryKind,
  type HazardAdditionDraft,
  type HazardDef,
  type HazardRemoval,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyHazardAdditions,
  applyHazardRemovals,
  keepHazards,
  readHazardAssessment,
  recordHazardRead,
  undoHazardAddition,
} from './hazard-assessment';
import { getProject } from './projects';
import type { Store } from './store';
import { createTestStore, seedProject } from './test-support';

let store: Store;
let close: () => void;
beforeEach(() => {
  ({ store, close } = createTestStore());
});
afterEach(() => {
  close();
});

const command = (
  hazard: string,
  value: string,
  file = 'Makefile',
  line = 3,
): HazardAdditionDraft => ({
  hazard,
  kind: HazardEntryKind.Command,
  value,
  reason: `${value} writes it`,
  evidence: { file, line },
});
const glob = (hazard: string, value: string, file: string): HazardAdditionDraft => ({
  hazard,
  kind: HazardEntryKind.Glob,
  value,
  reason: `${value} is tracked`,
  evidence: { file },
});

function hazard(projectId: string, name: string): HazardDef | undefined {
  return getProject(store.db, projectId as never).hazards.find((h) => h.name === name);
}

describe('applying hazard additions', () => {
  it('appends a command and a glob to the named hazard and lists them with their evidence', () => {
    const project = seedProject(store);
    const applied = store.write((ctx) =>
      applyHazardAdditions(ctx, project.id, [
        command('deps', 'make backend-lock'),
        glob('deps', 'amps/backend/poetry.lock', 'amps/backend/poetry.lock'),
      ]),
    ).value;
    expect(applied.map((a) => a.value)).toEqual(['make backend-lock', 'amps/backend/poetry.lock']);
    expect(hazard(project.id, 'deps')?.commands).toContain('make backend-lock');
    expect(hazard(project.id, 'deps')?.globs).toContain('amps/backend/poetry.lock');
    const state = readHazardAssessment(store.db, project.id);
    expect(state.additions).toHaveLength(2);
    expect(state.additions[0]).toMatchObject({
      hazard: 'deps',
      value: 'make backend-lock',
      evidence: { file: 'Makefile', line: 3 },
    });
  });

  it('adds nothing a hazard already holds and nothing twice', () => {
    const project = seedProject(store);
    const stock = DEFAULT_HAZARDS.find((h) => h.name === 'migrations')?.commands[0] ?? '';
    store.write((ctx) => applyHazardAdditions(ctx, project.id, [command('migrations', stock)]));
    expect(readHazardAssessment(store.db, project.id).additions).toEqual([]);
    store.write((ctx) => applyHazardAdditions(ctx, project.id, [command('deps', 'make lock')]));
    const again = store.write((ctx) =>
      applyHazardAdditions(ctx, project.id, [command('deps', 'make lock')]),
    ).value;
    expect(again).toEqual([]);
    expect(readHazardAssessment(store.db, project.id).additions).toHaveLength(1);
  });

  it('makes a new hazard only when a glob comes with it, held by the whole project', () => {
    const project = seedProject(store);
    store.write((ctx) =>
      applyHazardAdditions(ctx, project.id, [
        command('exports', 'python3 amps/dev_export.py'),
        command('lonely', 'make lonely'),
        glob('exports', 'amps/exports/**', 'amps/exports/a.json'),
      ]),
    );
    const made = hazard(project.id, 'exports');
    expect(made?.commands).toEqual(['python3 amps/dev_export.py']);
    expect(made?.globs).toEqual(['amps/exports/**']);
    expect(made?.scope).toBe('project');
    expect(hazard(project.id, 'lonely')).toBeUndefined();
  });

  it('never makes a hazard of an area name', () => {
    const project = seedProject(store);
    const applied = store.write((ctx) =>
      applyHazardAdditions(ctx, project.id, [glob('api', 'src/api/x.lock', 'src/api/x.lock')]),
    ).value;
    expect(applied).toEqual([]);
  });
});

describe('undoing an addition', () => {
  it('takes the entry out of the hazard and is not added again', () => {
    const project = seedProject(store);
    const [added] = store.write((ctx) =>
      applyHazardAdditions(ctx, project.id, [command('deps', 'make lock')]),
    ).value;
    expect(added).toBeDefined();
    store.write((ctx) => {
      undoHazardAddition(ctx, project.id, added?.id ?? '');
    });
    expect(hazard(project.id, 'deps')?.commands).not.toContain('make lock');
    expect(readHazardAssessment(store.db, project.id).additions).toEqual([]);
    const again = store.write((ctx) =>
      applyHazardAdditions(ctx, project.id, [command('deps', 'make lock')]),
    ).value;
    expect(again).toEqual([]);
    expect(hazard(project.id, 'deps')?.commands).not.toContain('make lock');
  });

  it('drops a hazard it made when its last entry goes', () => {
    const project = seedProject(store);
    const [added] = store.write((ctx) =>
      applyHazardAdditions(ctx, project.id, [glob('exports', 'out/a.json', 'out/a.json')]),
    ).value;
    store.write((ctx) => {
      undoHazardAddition(ctx, project.id, added?.id ?? '');
    });
    expect(hazard(project.id, 'exports')).toBeUndefined();
  });

  it('refuses an addition that is not listed', () => {
    const project = seedProject(store);
    expect(() =>
      store.write((ctx) => {
        undoHazardAddition(ctx, project.id, 'nope');
      }),
    ).toThrow(/hazard addition nope not found/);
  });
});

describe('removals the builder agreed to', () => {
  const removal = (value: string): HazardRemoval => ({
    hazard: 'deps',
    kind: HazardEntryKind.Command,
    value,
    reason: 'The target is gone',
    evidence: { file: 'Makefile', line: 1 },
  });

  it('takes the entries out, forgets their additions and does not add them back', () => {
    const project = seedProject(store);
    store.write((ctx) => applyHazardAdditions(ctx, project.id, [command('deps', 'make old')]));
    store.write((ctx) => {
      applyHazardRemovals(ctx, project.id, [removal('make old')]);
    });
    expect(hazard(project.id, 'deps')?.commands).not.toContain('make old');
    expect(readHazardAssessment(store.db, project.id).additions).toEqual([]);
    const again = store.write((ctx) =>
      applyHazardAdditions(ctx, project.id, [command('deps', 'make old')]),
    ).value;
    expect(again).toEqual([]);
  });

  it('leaves a kept entry in place and records that the builder kept it', () => {
    const project = seedProject(store);
    store.write((ctx) => applyHazardAdditions(ctx, project.id, [command('deps', 'make old')]));
    store.write((ctx) => {
      keepHazards(ctx, project.id, [removal('make old')]);
    });
    expect(hazard(project.id, 'deps')?.commands).toContain('make old');
    expect(readHazardAssessment(store.db, project.id).kept).toEqual([
      { hazard: 'deps', kind: 'command', value: 'make old' },
    ]);
  });
});

describe('recording a read', () => {
  it('keeps the commit and when it was read', () => {
    const project = seedProject(store);
    expect(readHazardAssessment(store.db, project.id).assessedAt).toBeNull();
    store.write((ctx) => {
      recordHazardRead(ctx, project.id, 'abc123');
    });
    const state = readHazardAssessment(store.db, project.id);
    expect(state.commit).toBe('abc123');
    expect(state.assessedAt).not.toBeNull();
  });
});
