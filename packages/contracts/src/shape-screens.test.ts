import { describe, expect, it } from 'vitest';
import {
  ScreenImageInput,
  ScreenMessageBody,
  ScreenName,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
  ShapeToolInputs,
  ShapeToolName,
  mintId,
} from './index';

// Shape spec §5.5: see_screen, a view of the app at a window size, answered with a screenshot.

const taskId = mintId('Task');

describe('see_screen input', () => {
  const parse = (value: unknown) => ShapeToolInputs.see_screen.safeParse(value);

  it('is a Shape tool', () => {
    expect(Object.values(ShapeToolName)).toContain('see_screen');
  });

  it('names one of five screens and defaults the window to 1200 by 900', () => {
    for (const screen of [
      ScreenName.Factory,
      ScreenName.Board,
      ScreenName.Inbox,
      ScreenName.Plan,
    ]) {
      expect(parse({ screen })).toMatchObject({
        success: true,
        data: { screen, width: SCREEN_WIDTH.default, height: SCREEN_HEIGHT.default },
      });
    }
    expect(parse({ screen: 'settings' }).success).toBe(false);
    expect(parse({}).success).toBe(false);
  });

  it('needs a task for the drawer and refuses one for any other screen', () => {
    expect(parse({ screen: 'task' }).success).toBe(false);
    expect(parse({ screen: 'task', taskId }).success).toBe(true);
    expect(parse({ screen: 'board', taskId }).success).toBe(false);
  });

  it('holds the window to a size a model can read and the API accepts', () => {
    expect(parse({ screen: 'board', width: 479 }).success).toBe(false);
    expect(parse({ screen: 'board', width: 1601 }).success).toBe(false);
    expect(parse({ screen: 'board', width: 480, height: 2000 }).success).toBe(true);
    expect(parse({ screen: 'board', height: 2001 }).success).toBe(false);
    expect(parse({ screen: 'board', width: 800.5 }).success).toBe(false);
  });

  it('takes no command, click, key or url', () => {
    expect(Object.keys(ShapeToolInputs.see_screen.shape).sort()).toEqual([
      'height',
      'screen',
      'taskId',
      'width',
    ]);
  });
});

describe('what the window sends back', () => {
  const image = { mediaType: 'image/png', data: 'AAAA', width: 1200, height: 900 };

  it('is a PNG or a JPEG with its size, never another type', () => {
    expect(ScreenImageInput.safeParse(image).success).toBe(true);
    expect(ScreenImageInput.safeParse({ ...image, mediaType: 'image/svg+xml' }).success).toBe(
      false,
    );
    expect(ScreenImageInput.safeParse({ ...image, data: '' }).success).toBe(false);
    expect(ScreenImageInput.safeParse({ ...image, width: 0 }).success).toBe(false);
  });

  it('is described in the transcript by a screen body that carries no image bytes', () => {
    const body = {
      screen: 'board',
      width: 1200,
      height: 900,
      name: '0001.png',
      mediaType: 'image/png',
    };
    expect(ScreenMessageBody.safeParse(body).success).toBe(true);
    expect(ScreenMessageBody.safeParse({ ...body, name: '../0001.png' }).success).toBe(false);
  });
});
