import { expect, test, type Page } from '@playwright/test';
import { z } from 'zod';
import { claudeIsInstalled } from './claude-is-installed';
import { daemonUrl } from './daemon-url';
import { auth, createProject } from './shape-project';

// Shape spec §5.5: see_screen with nothing played. A session on the fake adapter asks; the app's real
// host draws the screen in its hidden frame with html-to-image, in WebKit, which is what the shipped
// app renders in; the picture comes back through the daemon and shows in the conversation. The unit
// tests fake each of those seams, so this is the one place the capture itself runs.

const Picture = z.object({
  naturalWidth: z.number(),
  naturalHeight: z.number(),
  colours: z.number(),
  png: z.string(),
});

/** What the transcript's picture really holds, read back from its pixels. */
async function pictureOf(page: Page, name: RegExp): Promise<z.infer<typeof Picture>> {
  const image = page.getByRole('img', { name });
  await expect(image).toBeVisible();
  return Picture.parse(
    await image.evaluate(async (node: HTMLImageElement) => {
      await node.decode();
      const canvas = document.createElement('canvas');
      canvas.width = node.naturalWidth;
      canvas.height = node.naturalHeight;
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('no canvas');
      context.drawImage(node, 0, 0);
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      return {
        naturalWidth: node.naturalWidth,
        naturalHeight: node.naturalHeight,
        colours: new Set(new Uint32Array(data.buffer)).size,
        png: canvas.toDataURL('image/png'),
      };
    }),
  );
}

/** Keeps the picture with the test's results, so what was drawn can be looked at. */
async function keep(name: string, picture: z.infer<typeof Picture>): Promise<void> {
  await test.info().attach(name, {
    body: Buffer.from(picture.png.replace(/^data:image\/png;base64,/, ''), 'base64'),
    contentType: 'image/png',
  });
}

async function ask(page: Page, text: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Message' }).fill(text);
  await page.keyboard.press('ControlOrMeta+Enter');
}

/** Text anti-aliases into many shades: a screen with words on it is far past a handful of colours. */
const DRAWN_SCREEN_COLOURS = 16;

test('the window draws the Board and Plan for a session, and the conversation shows the real picture', async ({
  page,
  request,
}) => {
  const projectId = await createProject(request, 'see-screen');
  const task = await request.post(`${daemonUrl}/projects/${projectId}/tasks`, {
    headers: auth,
    data: { title: 'A task to be seen', acceptanceCriteria: ['it shows'], areas: ['repo'] },
  });
  expect(task.ok()).toBe(true);

  await claudeIsInstalled(page);
  await page.addInitScript((id: string) => {
    window.localStorage.setItem('tendb.project', JSON.stringify(id));
  }, projectId);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/shape');

  await ask(page, 'Please see the board at 900');
  await expect(page.getByText('I saw the board: 1 picture.')).toBeVisible();
  const board = await pictureOf(page, /The Board at 900×900/);
  await keep('board', board);
  expect(board.naturalWidth).toBe(900);
  expect(board.naturalHeight).toBe(900);
  expect(board.colours).toBeGreaterThan(DRAWN_SCREEN_COLOURS);

  // The conversation now holds a screenshot, which a frame must draw without reading the kept picture.
  await ask(page, 'Now please see the plan at 1000');
  await expect(page.getByText('I saw the plan: 1 picture.')).toBeVisible();
  const plan = await pictureOf(page, /Plan at 1000×900/);
  await keep('plan', plan);
  expect(plan.naturalWidth).toBe(1000);
  expect(plan.colours).toBeGreaterThan(DRAWN_SCREEN_COLOURS);
});
