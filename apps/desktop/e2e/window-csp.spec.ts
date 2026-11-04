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

  const outcome = await page.evaluate(
    async ({ elsewhere, data }) => {
      const blocked: string[] = [];
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
      style.textContent = `body { background-image: url(${elsewhere}?css); }`;
      document.head.append(style);
      document.body.getBoundingClientRect();
      const fromData = await load(data);
      const fromElsewhere = await load(`${elsewhere}?image`);
      // The violation events are queued; let them run.
      await new Promise((resolve) => setTimeout(resolve, 250));
      return { fromData, fromElsewhere, blocked };
    },
    // Another origin than the page's: the daemon, which the page may fetch but not draw.
    { elsewhere: `${daemonUrl}/health`, data: DATA_IMAGE },
  );

  expect(outcome.fromData).toBe(true);
  expect(outcome.fromElsewhere).toBe(false);
  expect(
    outcome.blocked.filter((entry) => entry.startsWith('img-src')).length,
  ).toBeGreaterThanOrEqual(2);
});
