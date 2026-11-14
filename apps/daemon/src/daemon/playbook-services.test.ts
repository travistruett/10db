import {
  mintId,
  NotFoundError,
  PlaybookMoveEntry,
  Rigor,
  StepRole,
  type KindDto,
} from '@10db/contracts';
import {
  createTestStore,
  listEventsAfter,
  listKinds,
  seedProject,
  setAppSetting,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventBus, createStateStore } from '../events';
import { PLAYBOOK_MOVE_REPORT_KEY } from '../team';
import { createPlaybookServices, type PlaybookApiServices } from './playbook-services';

let store: Store;
let close: () => void;
let services: PlaybookApiServices;
beforeEach(() => {
  ({ store, close } = createTestStore());
  services = createPlaybookServices(createStateStore(store, createEventBus()));
});
afterEach(() => {
  close();
});

const cellOf = (
  view: ReturnType<PlaybookApiServices['getPlaybook']>,
  rigor: Rigor,
  role: StepRole,
) => {
  const found = view.cells.find((c) => c.rigor === rigor && c.role === role);
  if (found === undefined) throw new Error(`no ${rigor} ${role} cell`);
  return found;
};

describe('the playbook through the services', () => {
  it('reads a global change back as global, and a project’s own over it as project', () => {
    const project = seedProject(store);
    services.setPlaybook(null, {
      cells: [{ rigor: Rigor.Standard, role: StepRole.Review, effort: 'low' }],
    });
    services.setPlaybook(project.id, {
      cells: [{ rigor: Rigor.Standard, role: StepRole.Review, effort: 'max' }],
    });
    expect(cellOf(services.getPlaybook(null), 'standard', 'review').effort).toEqual({
      value: 'low',
      source: 'global',
    });
    expect(cellOf(services.getPlaybook(project.id), 'standard', 'review').effort).toEqual({
      value: 'max',
      source: 'project',
    });
  });

  it('hands a cleared project cell back to the global one', () => {
    const project = seedProject(store);
    services.setPlaybook(null, {
      cells: [{ rigor: Rigor.Light, role: StepRole.Implement, effort: 'low' }],
    });
    services.setPlaybook(project.id, {
      cells: [{ rigor: Rigor.Light, role: StepRole.Implement, effort: 'high' }],
    });
    const view = services.setPlaybook(project.id, {
      cells: [{ rigor: Rigor.Light, role: StepRole.Implement }],
    });
    expect(cellOf(view, 'light', 'implement').effort).toEqual({ value: 'low', source: 'global' });
  });

  it('answers 404 for a project that does not exist, on a read and a write', () => {
    const missing = mintId('Project');
    expect(() => services.getPlaybook(missing)).toThrow(NotFoundError);
    expect(() =>
      services.setPlaybook(missing, { rows: [{ rigor: 'light', steps: null }] }),
    ).toThrow(NotFoundError);
  });

  it('announces a playbook change and a kind change as settings events', () => {
    const before = listEventsAfter(store.db, 0, 1000).length;
    services.setPlaybook(null, { rows: [{ rigor: Rigor.Light, steps: ['implement', 'review'] }] });
    const kind = services.createKind({ key: 'payments', label: 'Payments' });
    const events = listEventsAfter(store.db, 0, 1000).slice(before);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'settings.changed',
        entityType: 'playbook',
        entityId: 'all',
      }),
      expect.objectContaining({ type: 'settings.changed', entityType: 'kind', entityId: kind.id }),
    ]);
  });
});

describe('the kinds through the services', () => {
  const keys = (kinds: readonly KindDto[]) => kinds.map((k) => k.key);

  it('adds, patches and removes a kind, and refuses a key twice', () => {
    const made = services.createKind({
      key: 'payments',
      label: 'Payments',
      minimumRigor: 'careful',
    });
    expect(keys(services.listKinds())).toContain('payments');
    expect(services.patchKind(made.id, { alwaysReviewed: true })).toMatchObject({
      key: 'payments',
      alwaysReviewed: true,
      minimumRigor: 'careful',
    });
    expect(() => services.createKind({ key: 'payments', label: 'Again' })).toThrow(
      /already exists/,
    );
    services.deleteKind(made.id);
    expect(keys(services.listKinds())).not.toContain('payments');
    expect(() => {
      services.deleteKind(made.id);
    }).toThrow(NotFoundError);
  });

  it('moves a kind to a place and answers the new order', () => {
    const a = services.createKind({ key: 'aa', label: 'A' });
    const b = services.createKind({ key: 'bb', label: 'B' });
    const order = services.moveKind({ kindId: b.id, position: 0 });
    expect(keys(order).slice(0, 2)).toEqual(['bb', 'aa']);
    expect(keys(listKinds(store.db))).toEqual(keys(order));
    expect(a.position).toBeLessThan(b.position);
  });
});

describe('the move report through the services', () => {
  const entry = {
    setting: 'Pattern "api"',
    value: 'retry only',
    why: 'The playbook has no retry rule',
  };

  it('is empty before a move and after it is dismissed, and reads what the move kept', () => {
    expect(services.playbookMoveReport()).toEqual([]);
    store.write((ctx) => {
      setAppSetting(ctx, PLAYBOOK_MOVE_REPORT_KEY, [entry]);
    });
    expect(services.playbookMoveReport()).toEqual([PlaybookMoveEntry.parse(entry)]);
    services.dismissPlaybookMoveReport();
    expect(services.playbookMoveReport()).toEqual([]);
  });
});
