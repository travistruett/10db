import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AccountKind,
  InvalidError,
  mintId,
  ScreenMessageBody,
  ScreenName,
  SCREENS_PER_CONVERSATION,
  ShapeMessageKind,
  ShapeOrigin,
  type ScreenImageInput,
  type SeeScreenInput,
  type ShapeId,
} from '@10db/contracts';
import {
  createTestStore,
  insertShape,
  insertTask,
  listShapeMessages,
  seedProject,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pngImage as png } from '../../test/png';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { ToolImages } from '../mcp';
import type { ScreenBroker, ScreenOutcome, ScreenSpec } from './broker';
import { pictureLimitsFor } from './picture-limits';
import { createScreens } from './screens';

// Shape spec §5.5: see_screen. The service asks the window for a picture, checks it, keeps it with the
// conversation and shows it there; a screen that can't be drawn is a refusal that says why.

const asImage = (bytes: Buffer, width: number, height: number): ScreenImageInput => ({
  mediaType: 'image/png',
  data: bytes.toString('base64'),
  width,
  height,
});

/** A store with a project and one open conversation. */
interface Conversation {
  readonly store: Store;
  readonly project: ReturnType<typeof seedProject>;
  readonly shape: { readonly id: ShapeId };
  close(): void;
}

let c: Conversation;
let state: StateStore;
let filesDir: string;
let asked: ScreenSpec[];
let answer: ScreenOutcome;
const broker: ScreenBroker = {
  request: (spec) => {
    asked.push(spec);
    return Promise.resolve(answer);
  },
  claim: () => Promise.resolve(null),
  deliver: () => false,
  refuse: () => false,
  tokenValid: () => false,
};

beforeEach(() => {
  const { store, close } = createTestStore();
  const project = seedProject(store, { name: 'alpha' });
  const shape = store.write((ctx) =>
    insertShape(ctx, project.id, { title: 'Board polish', origin: ShapeOrigin.App }),
  ).value;
  c = { store, project, shape, close };
  state = createStateStore(c.store, createEventBus());
  filesDir = mkdtempSync(join(tmpdir(), 'screens-'));
  asked = [];
  answer = { ok: true, image: asImage(png(1200, 900), 1200, 900) };
});
afterEach(() => {
  c.close();
  rmSync(filesDir, { recursive: true, force: true });
});

const screens = () => {
  const service = createScreens({ state, broker, filesDir });
  return {
    ...service,
    // These tests are not about the budget, so they run on a Claude plan's limits.
    see: (shapeId: ShapeId, input: SeeScreenInput) =>
      service.see(shapeId, input, pictureLimitsFor(AccountKind.ClaudeSubscription)),
  };
};
const board = { screen: ScreenName.Board, width: 1200, height: 900 } as const;
const rows = () => listShapeMessages(c.store.db, c.shape.id);

describe('see_screen', () => {
  it('answers the picture and a line saying what it is', async () => {
    const result = await screens().see(c.shape.id, board);
    expect(result).toBeInstanceOf(ToolImages);
    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatchObject({ mediaType: 'image/png' });
    expect(Buffer.from(result.images[0]?.data ?? '', 'base64')).toEqual(png(1200, 900));
    expect(result.text).toMatch(/Board.*1200.*900/);
  });

  it('asks for the conversation’s project, the screen and the window', async () => {
    await screens().see(c.shape.id, board);
    expect(asked).toEqual([
      {
        shapeId: c.shape.id,
        projectId: c.project.id,
        screen: 'board',
        width: 1200,
        height: 900,
      },
    ]);
  });

  it('asks for a task’s drawer by its task, and for Plan as this conversation', async () => {
    const task = c.store.write((ctx) =>
      insertTask(ctx, c.project.id, { title: 'A task', acceptanceCriteria: ['x'], areas: ['api'] }),
    ).value;
    answer = { ok: true, image: asImage(png(900, 700), 900, 700) };
    await screens().see(c.shape.id, {
      screen: 'task',
      taskId: task.id,
      width: 900,
      height: 700,
    });
    await screens().see(c.shape.id, { screen: 'plan', width: 900, height: 700 });
    expect(asked.map((a) => [a.screen, a.taskId])).toEqual([
      ['task', task.id],
      ['plan', undefined],
    ]);
  });

  it('keeps the picture with the conversation, and shows it there as a row of its own', async () => {
    await screens().see(c.shape.id, board);
    const screen = rows().filter((m) => m.kind === ShapeMessageKind.Screen);
    expect(screen).toHaveLength(1);
    const body = ScreenMessageBody.parse(JSON.parse(screen[0]?.body ?? ''));
    expect(body).toMatchObject({ screen: 'board', width: 1200, height: 900, name: '0001.png' });
    expect(readFileSync(join(filesDir, c.shape.id, 'screens', body.name))).toEqual(png(1200, 900));
    // The row names the image; it never holds it.
    expect(screen[0]?.body.length).toBeLessThan(300);
    expect(
      rows().some((m) => m.kind === ShapeMessageKind.Tool && m.body.includes('see_screen · board')),
    ).toBe(true);
  });

  it('numbers a conversation’s screens, so one never overwrites another', async () => {
    await screens().see(c.shape.id, board);
    await screens().see(c.shape.id, board);
    expect(readdirSync(join(filesDir, c.shape.id, 'screens')).sort()).toEqual([
      '0001.png',
      '0002.png',
    ]);
  });

  it('refuses a screen the window could not draw, with the window’s reason, and keeps nothing', async () => {
    answer = { ok: false, reason: 'The Board failed to load: the daemon answered 500' };
    await expect(screens().see(c.shape.id, board)).rejects.toThrow(
      new InvalidError('The Board failed to load: the daemon answered 500'),
    );
    expect(rows().filter((m) => m.kind === ShapeMessageKind.Screen)).toEqual([]);
    expect(rows().map((m) => m.body)).toContain(
      'see_screen · refused · The Board failed to load: the daemon answered 500',
    );
    expect(existsSync(join(filesDir, c.shape.id))).toBe(false);
  });

  it('refuses the drawer of a task that is not in the conversation’s project', async () => {
    const other = seedProject(c.store, { name: 'beta' });
    const task = c.store.write((ctx) =>
      insertTask(ctx, other.id, { title: 'Theirs', acceptanceCriteria: ['x'], areas: ['api'] }),
    ).value;
    await expect(
      screens().see(c.shape.id, { screen: 'task', taskId: task.id, width: 900, height: 700 }),
    ).rejects.toThrow(/not in this project/);
    await expect(
      screens().see(c.shape.id, {
        screen: 'task',
        taskId: mintId('Task'),
        width: 900,
        height: 700,
      }),
    ).rejects.toThrow(/not in this project/);
    expect(asked).toEqual([]);
  });

  describe('a picture that is not what was asked for', () => {
    const refused = async (image: ScreenImageInput, pattern: RegExp): Promise<void> => {
      answer = { ok: true, image };
      await expect(screens().see(c.shape.id, board)).rejects.toThrow(pattern);
      expect(rows().filter((m) => m.kind === ShapeMessageKind.Screen)).toEqual([]);
      expect(existsSync(join(filesDir, c.shape.id))).toBe(false);
    };

    it('is refused when it is not an image', async () => {
      await refused(
        asImage(Buffer.from('<html>not an image</html>'), 1200, 900),
        /not a PNG or a JPEG/,
      );
    });

    it('is refused when its header does not match the type it was sent as', async () => {
      await refused(
        { ...asImage(png(1200, 900), 1200, 900), mediaType: 'image/jpeg' },
        /not a PNG or a JPEG/,
      );
    });

    it('is refused when it is larger than the window asked for', async () => {
      await refused(asImage(png(1300, 900), 1300, 900), /larger than the window/);
      await refused(asImage(png(1200, 1500), 1200, 1500), /larger than the window/);
    });

    it('is refused when it says one size and holds another', async () => {
      await refused(asImage(png(800, 600), 1200, 900), /says 1200 by 900/);
    });

    it('is refused when it is too big to keep in a conversation', async () => {
      await refused(asImage(png(1200, 900, 1_600_000), 1200, 900), /too large/);
    });

    it('is refused when it is empty of picture: a header and nothing else', async () => {
      await refused(asImage(png(1200, 900).subarray(0, 12), 1200, 900), /not a PNG or a JPEG/);
      await refused(asImage(png(1200, 900).subarray(0, 33), 1200, 900), /not a PNG or a JPEG/);
    });

    it('is refused when it was cut short: its size is right and its end is missing', async () => {
      const whole = png(1200, 900);
      await refused(asImage(whole.subarray(0, whole.length - 1), 1200, 900), /not a PNG or a JPEG/);
    });
  });

  it('allows twelve screens in a conversation and refuses the next, which would crowd the session', async () => {
    for (let n = 0; n < SCREENS_PER_CONVERSATION; n += 1) await screens().see(c.shape.id, board);
    asked = [];
    await expect(screens().see(c.shape.id, board)).rejects.toThrow(
      new RegExp(`${String(SCREENS_PER_CONVERSATION)} screens`),
    );
    expect(asked).toEqual([]);
  });

  it('serves a kept picture by name, and nothing that is not a name it gave', async () => {
    await screens().see(c.shape.id, board);
    const kept = screens().image(c.shape.id, '0001.png');
    expect(kept?.mediaType).toBe('image/png');
    expect(Buffer.from(kept?.bytes ?? [])).toEqual(png(1200, 900));
    expect(screens().image(c.shape.id, '0002.png')).toBeNull();
    for (const name of ['../0001.png', '0001.png/', '..%2f0001.png', 'x.png', '0001.svg', ''])
      expect(screens().image(c.shape.id, name), name).toBeNull();
    expect(screens().image(mintId('Shape'), '0001.png')).toBeNull();
  });
});
