import {
  FigmaAction,
  InvalidError,
  ShapeMessageAuthor,
  ShapeMessageKind,
  ShapeOrigin,
  type ProjectId,
} from '@10db/contracts';
import {
  createTestStore,
  getAppSetting,
  insertPlanSession,
  insertShapeAttachment,
  insertShapeMessage,
  seedProject,
} from '@10db/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StateStore } from '../events';
import { createFigmaPresses, createFigmaTools } from './figma';

let handle: ReturnType<typeof createTestStore> | undefined;
afterEach(() => {
  handle?.close();
  handle = undefined;
});

const SUBMIT =
  'https://mcp.figma.com/mcp/html_to_figma/8b0b822b-e1f0-4b12-90ba-d1003d7cd7a2/submit?promptId=p';

describe('send_mockup_to_figma', () => {
  it('posts a mock-up only for a press of the builder, once', async () => {
    handle = createTestStore();
    const { store } = handle;
    const projectId: ProjectId = seedProject(store).id;
    const { shape } = store.write((ctx) =>
      insertPlanSession(ctx, {
        projectId,
        title: 'Plan',
        origin: ShapeOrigin.App,
        tabPosition: null,
      }),
    ).value;
    const mockup = store.write((ctx) =>
      insertShapeAttachment(ctx, {
        shapeId: shape.id,
        kind: 'mockup',
        key: 'density',
        body: '<p>secret</p>',
        goalId: null,
        taskId: null,
      }),
    ).value;
    const state: StateStore = {
      db: store.db,
      now: () => store.now(),
      write: (fn) => store.write(fn).value,
    };
    const post = vi.fn(() =>
      Promise.resolve(
        Response.json({
          success: true,
          fileUrl: 'https://www.figma.com/design/abc?node-id=1-2',
          nodeIds: ['1:2'],
        }),
      ),
    );
    const presses = createFigmaPresses(() => Date.now());
    const tools = createFigmaTools({ state, fetch: post, presses }, projectId);
    const send = () => tools.send(shape.id, { attachmentId: mockup.id, submitUrl: SUBMIT });

    // No press: refused, nothing leaves the Mac and nothing is stored.
    await expect(send()).rejects.toBeInstanceOf(InvalidError);
    expect(post).not.toHaveBeenCalled();
    expect(getAppSetting(store.db, `figma-frame.${mockup.id}`)).toBeUndefined();

    // A press lets one send through; a second is refused.
    const press = store.write((ctx) =>
      insertShapeMessage(ctx, shape.id, {
        author: ShapeMessageAuthor.Note,
        kind: ShapeMessageKind.FigmaOpen,
        body: 'Open in Figma',
      }),
    ).value;
    presses.add(shape.id, mockup.id, FigmaAction.Open, press.id);
    await expect(send()).resolves.toMatchObject({ nodeId: '1:2' });
    expect(post).toHaveBeenCalledTimes(1);
    await expect(send()).rejects.toBeInstanceOf(InvalidError);
    expect(post).toHaveBeenCalledTimes(1);
  });
});
