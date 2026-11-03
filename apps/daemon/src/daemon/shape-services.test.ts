import { mintId, ShapeOrigin, type ShapeDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import type { ShapeService } from '../shape';
import { createShapeServices } from './shape-services';

// The Shape routes' side of the services: a new conversation's title, and Convert's two answers.

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
