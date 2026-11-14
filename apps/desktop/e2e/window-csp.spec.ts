import { expect, test } from '@playwright/test';
import { claudeIsInstalled } from './claude-is-installed';
import { daemonUrl } from './daemon-url';
import { createProject } from './shape-project';

// The browser modes (`pnpm dev`, `pnpm dev:factory`) serve the UI from Vite, which has no CSP of its own;
// vite.config.ts gives its pages the window's img-src (window-csp.ts). jsdom enforces no CSP, so this is
// the one place the policy is seen to stop a load, in WebKit, which is what the shipped app renders in.

const DATA_IMAGE =
  'data:image/svg+xml;charset=utf-8,%3Csvg xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22 width%3D%221%22 height%3D%221%22%2F%3E';

test("a page Vite serves carries the window's img-src and stops an image from elsewhere", async ({
  page,
}) => {
  const response = await page.goto('/');
  expect(response?.headers()['content-security-policy']).toBe("img-src 'self' data:");

  // The violation events stay on the page, in `window.cspBlocked`, and the test waits for them below.
  // Each load goes to its own origin, not just its own path: WebKit may reduce a cross-origin blocked
  // URI to its origin, and the origins tell the loads apart either way. Both hosts reach the daemon's
  // port, not the page's, so both are another origin than the page's `localhost`.
  const imageOrigin = daemonUrl;
  const styleOrigin = `http://localhost:${new URL(daemonUrl).port}`;

  const outcome = await page.evaluate(
    async ({ image: imageSrc, style: styleSrc, data }) => {
      const blocked: string[] = [];
      (window as unknown as { cspBlocked: string[] }).cspBlocked = blocked;
      document.addEventListener('securitypolicyviolation', (event) => {
        blocked.push(`${event.violatedDirective} ${event.blockedURI}`);
      });
      const load = (src: string): Promise<boolean> =>
        new Promise((resolve) => {
          const image = new Image();
          image.onload = () => {
            resolve(true);
          };
          image.onerror = () => {
            resolve(false);
          };
          image.src = src;
        });
      // A stylesheet url() is an image load too.
      const style = document.createElement('style');
      style.textContent = `body { background-image: url(${styleSrc}); }`;
      document.head.append(style);
      document.body.getBoundingClientRect();
      const fromData = await load(data);
      const fromElsewhere = await load(imageSrc);
      return { fromData, fromElsewhere };
    },
    // Another origin than the page's: the daemon, which the page may fetch but not draw.
    {
      image: `${imageOrigin}/health/image`,
      style: `${styleOrigin}/health/style`,
      data: DATA_IMAGE,
    },
  );

  expect(outcome.fromData).toBe(true);
  expect(outcome.fromElsewhere).toBe(false);

  // The violation events are queued after the loads settle: wait for them by condition.
  const isBlocked = (origin: string): Promise<boolean> =>
    page.evaluate(
      (prefix) =>
        (window as unknown as { cspBlocked: string[] }).cspBlocked.some((entry) =>
          entry.startsWith(prefix),
        ),
      `img-src ${origin}`,
    );
  await expect
    .poll(() => isBlocked(imageOrigin), { message: 'the new Image() load is reported blocked' })
    .toBe(true);
  await expect
    .poll(() => isBlocked(styleOrigin), {
      message: 'the stylesheet url() load is reported blocked',
    })
    .toBe(true);
});

// The window's CSP has no `script-src`, so its `default-src 'self'` allows neither WebAssembly nor
// eval. A Plan reply with a fence highlights under that policy, with none of streamdown's own
// highlighter, Mermaid or KaTeX chunks requested, and its link asks before it opens.
test('a fence highlights under a script policy with no eval or WebAssembly, and a link asks first', async ({
  page,
  request,
}) => {
  const projectId = await createProject(request, 'window-csp');
  const requested: string[] = [];
  page.on('request', (r) => {
    requested.push(r.url());
  });
  await page.route(
    (url) => !url.pathname.includes('.') && !url.pathname.startsWith('/@'),
    async (route) => {
      if (route.request().resourceType() !== 'document') {
        await route.fallback();
        return;
      }
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: {
          ...response.headers(),
          'content-security-policy': "img-src 'self' data:; script-src 'self' 'unsafe-inline'",
        },
      });
    },
  );
  await page.addInitScript((id: string) => {
    window.localStorage.setItem('tendb.project', JSON.stringify(id));
    const violations: string[] = [];
    (window as unknown as { cspViolations: string[] }).cspViolations = violations;
    document.addEventListener('securitypolicyviolation', (event) => {
      violations.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  }, projectId);
  await claudeIsInstalled(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const response = await page.goto('/shape');
  expect(response?.headers()['content-security-policy']).toContain('script-src');

  // zod probes once, at its first parse, whether eval is allowed, which the policy reports; the
  // reply is drawn after that, so only what drawing it set off is kept.
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { cspViolations: string[] }).cspViolations.length = 0;
  });
  await page.getByRole('textbox', { name: 'Message' }).fill('Please show a fence');
  await page.keyboard.press('ControlOrMeta+Enter');
  const fence = page.locator('pre').filter({ hasText: 'export const retries' });
  await expect(fence).toBeVisible();

  // Highlighted: some token in the block is drawn in another color than the block's own text.
  await expect
    .poll(() =>
      fence.evaluate((pre) => {
        const base = getComputedStyle(pre).color;
        return [...pre.querySelectorAll('span')].some((s) => getComputedStyle(s).color !== base);
      }),
    )
    .toBe(true);
  expect(
    await page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations),
  ).toEqual([]);
  // Streamdown's own lazy chunks, by their hashed names (`mermaid-WFAXDIZX`); 10db's attachments
  // load the mermaid package itself, which is not streamdown's.
  expect(requested.filter((url) => /highlighted-body|mermaid-[A-Z0-9]{8}|katex/.test(url))).toEqual(
    [],
  );

  // The link asks first, naming the address's host, and Cancel leaves the page where it was.
  const before = page.url();
  await page.getByRole('link', { name: 'docs' }).click();
  const confirm = page.getByRole('dialog', { name: 'Open example.com in your browser?' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toBeHidden();
  expect(page.url()).toBe(before);
  expect(page.context().pages()).toHaveLength(1);
});
