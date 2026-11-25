import { expect, type Page } from '@playwright/test';
import { z } from 'zod';
import { claudeIsInstalled } from './claude-is-installed';
import { test } from './routed-test';
import { daemonUrl } from './daemon-url';
import { openNewPlan } from './new-plan-session';
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

/**
 * What the transcript's picture really holds, read back from its pixels. WebKit may paint an image to a
 * canvas as blank while its decoded bitmap is not yet ready to draw, though `decode()` has resolved, so
 * each read decodes the picture afresh and the read repeats until it holds a drawn screen. The bytes the
 * daemon served are what a failure here would be about; a picture that really is blank stays blank.
 */
async function pictureOf(page: Page, name: RegExp): Promise<z.infer<typeof Picture>> {
  const image = page.getByRole('img', { name });
  await expect(image).toBeVisible();
  let last: z.infer<typeof Picture> | undefined;
  await expect
    .poll(
      async () => {
        last = Picture.parse(
          await image.evaluate(async (node: HTMLImageElement) => {
            const copy = new Image();
            copy.src = node.currentSrc;
            await copy.decode();
            const canvas = document.createElement('canvas');
            canvas.width = copy.naturalWidth;
            canvas.height = copy.naturalHeight;
            const context = canvas.getContext('2d');
            if (context === null) throw new Error('no canvas');
            context.drawImage(copy, 0, 0);
            const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
            return {
              naturalWidth: copy.naturalWidth,
              naturalHeight: copy.naturalHeight,
              colours: new Set(new Uint32Array(data.buffer)).size,
              png: canvas.toDataURL('image/png'),
            };
          }),
        );
        return last.colours;
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(DRAWN_SCREEN_COLOURS);
  if (last === undefined) throw new Error('the picture was never read');
  return last;
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

/**
 * The daemon answers every `see_screen` within 20 s of asking (`renderTimeoutMs` in `screens/broker.ts`),
 * with the picture or the reason there is none. The window's own draw budget sits inside those 20 s, and
 * the session replies once it has that answer, so 30 s is the deadline plus room for the reply.
 */
const CAPTURE_REPLY_WAIT_MS = 30_000;

/**
 * A reply is final once it shows, so a reply that is not the caption fails after this, not after the
 * config's default 20 s expect timeout.
 */
const REPLY_SETTLE_MS = 1_000;

/**
 * Waits for the session's reply to a screen request, then checks that it is the caption for the picture.
 * The reply is that caption, or `I could not see it:` and the reason the window or the daemon gave, so a
 * refusal fails here with its reason in the message rather than as a timeout that says nothing.
 */
async function expectSeen(page: Page, caption: string): Promise<void> {
  const reply = page.getByText(caption, { exact: true }).or(page.getByText(/^I could not see it:/));
  await expect(reply).toBeVisible({ timeout: CAPTURE_REPLY_WAIT_MS });
  await expect(reply).toHaveText(caption, { timeout: REPLY_SETTLE_MS });
}

test('the window draws the Board and Plan for a session, and the conversation shows the real picture', async ({
  page,
  request,
}) => {
  // Two replies, each within its wait, plus the picture reads and the page's own setup.
  test.setTimeout(2 * CAPTURE_REPLY_WAIT_MS + 60_000);
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
  await openNewPlan(page);

  await ask(page, 'Please see the board at 900');
  await expectSeen(page, 'I saw the board: 1 picture.');
  const board = await pictureOf(page, /The Board at 900×900/);
  await keep('board', board);
  expect(board.naturalWidth).toBe(900);
  expect(board.naturalHeight).toBe(900);
  expect(board.colours).toBeGreaterThan(DRAWN_SCREEN_COLOURS);

  // The conversation now holds a screenshot, which a frame must draw without reading the kept picture.
  await ask(page, 'Now please see the plan at 1000');
  await expectSeen(page, 'I saw the plan: 1 picture.');
  const plan = await pictureOf(page, /Plan at 1000×900/);
  await keep('plan', plan);
  expect(plan.naturalWidth).toBe(1000);
  expect(plan.colours).toBeGreaterThan(DRAWN_SCREEN_COLOURS);

  // Later specs open Sessions on its first session: the plan session this one made is archived, so it
  // does not fold their list.
  const open = z
    .array(z.looseObject({ id: z.string(), projectId: z.string() }))
    .parse(await (await request.get(`${daemonUrl}/chats?open=1`, { headers: auth })).json());
  for (const chat of open.filter((c) => c.projectId === projectId))
    await request.post(`${daemonUrl}/chats/${chat.id}/archive`, { headers: auth });
});
