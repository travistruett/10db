import { mintId, NotFoundError, ShapeOrigin, type ShapeDto } from '@10db/contracts';
import { createTestStore, listJudgeCalls, seedProject } from '@10db/db';
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore, type StateStore } from '../events';
import type { ShapeService } from '../shape';
import { createShapeServices } from './shape-services';

// The Shape routes' side of the services: a new conversation's title, Convert's two answers, the
// per-project opt-in for Jev's decisions and Settings' measures.

/** For the tests that reach only the shape service. */
const unused = { state: {} as StateStore, clock: new ManualClock() };

describe('the Jev opt-in and the measures', () => {
  it('is off for a project until it is turned on, and is per project', () => {
    const { store, close } = createTestStore();
    try {
      const a = seedProject(store, { name: 'a' });
      const b = seedProject(store, { name: 'b' });
      const services = createShapeServices({
        shape: {} as ShapeService,
        state: createStateStore(store, createEventBus()),
        clock: new ManualClock(),
      });
      expect(services.getShapeJev(a.id)).toEqual({ enabled: false });
      expect(services.setShapeJev(a.id, { enabled: true })).toEqual({ enabled: true });
      expect(services.getShapeJev(a.id)).toEqual({ enabled: true });
      expect(services.getShapeJev(b.id)).toEqual({ enabled: false });
      expect(() => services.getShapeJev(mintId('Project'))).toThrow(NotFoundError);
      expect(services.shapeMeasures()).toEqual({
        sizing: {
          n: 0,
          within: 0,
          buckets: {
            S: { n: 0, within: 0 },
            M: { n: 0, within: 0 },
            L: { n: 0, within: 0 },
            XL: { n: 0, within: 0 },
          },
          overrides: 0,
        },
        shadow: ['shape_ready', 'shape_record', 'shape_elsewhere'].map((decision) => ({
          decision,
          answered: 0,
          scored: 0,
          agreed: 0,
          canShow: false,
        })),
      });
      expect(listJudgeCalls(store.db, 10)).toEqual([]);
    } finally {
      close();
    }
  });
});

const AT = '2026-11-02T12:00:00.000Z';
const projectId = mintId('Project');
const shapeId = mintId('Shape');

function shapeOf(title: string): ShapeDto {
  return {
    id: shapeId,
    projectId,
    title,
    state: 'listening',
    origin: 'app',
    proposeUnlocked: false,
    round: 0,
    createdAt: AT,
    updatedAt: AT,
  };
}

describe('createShape', () => {
  it.each([
    ['no title is named by its first message later', {}, 'New conversation'],
    ['a title is kept', { title: 'Density' }, 'Density'],
  ])('%s', (_, input, expected) => {
    const asked: unknown[] = [];
    const services = createShapeServices({
      ...unused,
      shape: {
        create: (_project, made) => {
          asked.push(made);
          return shapeOf(made.title);
        },
      } as Pick<ShapeService, 'create'> as ShapeService,
    });
    services.createShape(projectId, input);
    expect(asked).toEqual([{ title: expected, origin: ShapeOrigin.App }]);
  });
});

describe('convertShape', () => {
  const proposalId = mintId('ShapeProposal');
  const taskId = mintId('Task');

  it('answers what was created, as the route sends it', async () => {
    const asked: unknown[] = [];
    const services = createShapeServices({
      ...unused,
      shape: {
        convert: (_id, ids, options) => {
          asked.push([ids, options]);
          return Promise.resolve({
            ok: true,
            createdNow: 1,
            results: [{ key: 'a', kind: 'task', taskIds: [taskId] }],
          });
        },
      } as Pick<ShapeService, 'convert'> as ShapeService,
    });
    const outcome = await services.convertShape(shapeId, {
      proposalIds: [proposalId],
      interrupt: true,
    });
    expect(outcome).toEqual({
      kind: 'converted',
      result: { createdNow: 1, results: [{ key: 'a', kind: 'task', taskIds: [taskId] }] },
    });
    expect(asked).toEqual([[[proposalId], { interrupt: true }]]);
  });

  it('answers every refusal', async () => {
    const services = createShapeServices({
      ...unused,
      shape: {
        convert: () => Promise.resolve({ ok: false, errors: ['A depends on B'] }),
      } as Pick<ShapeService, 'convert'> as ShapeService,
    });
    expect(await services.convertShape(shapeId, { proposalIds: [proposalId] })).toEqual({
      kind: 'refused',
      errors: ['A depends on B'],
    });
  });
});
