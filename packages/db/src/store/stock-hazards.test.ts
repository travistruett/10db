import { DEFAULT_HAZARDS, STOCK_HAZARD_REVISIONS, type HazardDef } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getProject, patchProject } from './projects';
import { getAppSetting, setAppSetting } from './settings';
import { addStockHazardCommands, STOCK_HAZARD_REVISION_KEY } from './stock-hazards';
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

/** The stock hazards as a project stored them before the first `revisions` revisions. */
function stockBefore(revisions: number): HazardDef[] {
  const later = new Set(
    STOCK_HAZARD_REVISIONS.slice(revisions).flatMap((r) => Object.values(r).flat()),
  );
  return DEFAULT_HAZARDS.map((h) => ({ ...h, commands: h.commands.filter((c) => !later.has(c)) }));
}

function commands(hazards: readonly HazardDef[], name: string): readonly string[] {
  return hazards.find((h) => h.name === name)?.commands ?? [];
}

const LATEST = STOCK_HAZARD_REVISIONS.length;

describe('adding the newer stock hazard commands', () => {
  it('gives a project stored before the latest revision every stock command, after its own', () => {
    const before = stockBefore(LATEST - 1);
    const old = seedProject(store, { hazards: before });
    store.write((ctx) => {
      addStockHazardCommands(ctx);
    });
    const hazards = getProject(store.db, old.id).hazards;
    for (const stock of DEFAULT_HAZARDS)
      expect([...commands(hazards, stock.name)].sort()).toEqual([...stock.commands].sort());
    expect(commands(hazards, 'deps').slice(0, commands(before, 'deps').length)).toEqual(
      commands(before, 'deps'),
    );
    expect(getAppSetting(store.db, STOCK_HAZARD_REVISION_KEY)).toBe(LATEST);
  });

  it('gives a project stored at the first release every revision', () => {
    const first = seedProject(store, { hazards: stockBefore(0) });
    store.write((ctx) => {
      addStockHazardCommands(ctx);
    });
    expect([...commands(getProject(store.db, first.id).hazards, 'deps')].sort()).toEqual(
      [...commands(DEFAULT_HAZARDS, 'deps')].sort(),
    );
  });

  it('keeps a command removed after the revisions were added removed on every later start', () => {
    const project = seedProject(store, { hazards: stockBefore(LATEST - 1) });
    store.write((ctx) => {
      addStockHazardCommands(ctx);
    });
    const trimmed = getProject(store.db, project.id).hazards.map((h) =>
      h.name === 'deps' ? { ...h, commands: h.commands.filter((c) => c !== 'bun add') } : h,
    );
    store.write((ctx) => {
      patchProject(ctx, project.id, { hazards: trimmed });
    });
    store.write((ctx) => {
      addStockHazardCommands(ctx);
    });
    expect(commands(getProject(store.db, project.id).hazards, 'deps')).not.toContain('bun add');
  });

  it('keeps a command removed before the revisions were tracked removed', () => {
    // A project added at the latest revision, before 10db recorded one, that dropped `bun add`.
    const hazards = DEFAULT_HAZARDS.map((h) =>
      h.name === 'deps' ? { ...h, commands: h.commands.filter((c) => c !== 'bun add') } : h,
    );
    const project = seedProject(store, { hazards });
    store.write((ctx) => {
      addStockHazardCommands(ctx);
    });
    expect(getProject(store.db, project.id).hazards).toEqual(hazards);
  });

  it('adds only the revisions the database has not had', () => {
    const before = stockBefore(LATEST - 1);
    store.write((ctx) => {
      setAppSetting(ctx, STOCK_HAZARD_REVISION_KEY, LATEST);
    });
    const project = seedProject(store, { hazards: before });
    store.write((ctx) => {
      addStockHazardCommands(ctx);
    });
    expect(getProject(store.db, project.id).hazards).toEqual(before);
  });

  it('leaves the builder’s own hazards and a renamed or removed stock hazard alone', () => {
    const own = { name: 'docker', globs: ['Dockerfile'], commands: ['docker build'] };
    const hazards = [
      own,
      {
        name: 'packages',
        globs: ['**/package.json'],
        commands: [...commands(stockBefore(0), 'deps')],
      },
    ];
    const project = seedProject(store, { hazards });
    store.write((ctx) => {
      addStockHazardCommands(ctx);
    });
    expect(getProject(store.db, project.id).hazards).toEqual(hazards);
  });
});
