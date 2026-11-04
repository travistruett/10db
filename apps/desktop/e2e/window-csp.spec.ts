import { expect, test } from '@playwright/test';
import { daemonUrl } from './daemon-url';

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
