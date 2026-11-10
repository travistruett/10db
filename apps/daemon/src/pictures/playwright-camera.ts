import { routeUrl, ScreenTheme, type AppUrl } from '@10db/contracts';
import type { Browser, BrowserContext, Page, Response } from 'playwright-core';
import type { Logger } from '../log';
import { NO_ANSWER, NO_ANSWER_HEADER, type AppProxy } from './app-proxy';
import type { BrowserHost } from './browser-host';
import { ShotOutcome, type PageCamera, type Shot } from './camera';
import { requestAllowed } from './origin-guard';
import { addressForLog, loadFailure } from './load-failure';
import { capOverlayText, OVERLAY_SELECTORS } from './overlay';
import { shotOutcome, type PageLoad } from './shot-outcome';
import { StorageState } from './storage-state';

/** How long a page gets to load. */
const LOAD_TIMEOUT_MS = 30_000;
/** How long a loaded page gets to go quiet, and its fonts to load, before it is shot anyway. */
const SETTLE_TIMEOUT_MS = 5_000;
/** How long reading an overlay's text may take. */
const OVERLAY_READ_MS = 1_000;

/** A sign-in that gave no state: the message says why, for the status line. */
export class SignInError extends Error {
  override readonly name = 'SignInError';
}

/**
 * Lets through only what `requestAllowed` allows, and names in the log what it refused. A redirect's
 * next hop never reaches a route, so the daemon's proxy is what holds; this is the first check.
 */
async function guard(context: BrowserContext, appUrl: AppUrl, logger: Logger): Promise<void> {
  await context.route('**/*', async (route, request) => {
    const url = request.url();
    if (requestAllowed(appUrl, url)) {
      await route.continue();
      return;
    }
    logger.info({ url: addressForLog(url) }, 'the pictures browser refused a request off the app');
    await route.abort('blockedbyclient');
  });
  await context.routeWebSocket(
    () => true,
    (socket) => {
      const url = socket.url();
      if (requestAllowed(appUrl, url)) {
        socket.connectToServer();
        return;
      }
      logger.info(
        { url: addressForLog(url) },
        'the pictures browser refused a WebSocket off the app',
      );
      void socket.close({ code: 1008, reason: 'off the app' });
    },
  );
}

/** Why a load or a sign-in failed when the proxy, not the app, answered. */
const APP_DID_NOT_ANSWER = 'the app did not answer';

/** Whether the answer is the proxy's own 502: the app refused the connection, reset it or garbled it. */
function unanswered(response: Response | null): boolean {
  return response?.headers()[NO_ANSWER_HEADER] === NO_ANSWER;
}

/** The text of the first dev-server overlay up on the page, capped; null when none is. */
async function overlayOn(page: Page): Promise<string | null> {
  for (const overlay of OVERLAY_SELECTORS) {
    if ((await page.locator(overlay.selector).count()) === 0) continue;
    const text = await page
      .locator(overlay.text)
      .first()
      .innerText({ timeout: OVERLAY_READ_MS })
      .catch(() => '');
    return capOverlayText(text);
  }
  return null;
}

/** Loads `url` and waits, within bounds, for the page to go quiet and its fonts to load. */
async function load(page: Page, url: string): Promise<PageLoad> {
  let status: number | null;
  try {
    const response = await page.goto(url, { waitUntil: 'load', timeout: LOAD_TIMEOUT_MS });
    if (unanswered(response)) {
      return { error: APP_DID_NOT_ANSWER, landedUrl: null, status: null, overlayText: null };
    }
    status = response?.status() ?? null;
  } catch (error) {
    return { error: loadFailure(error), landedUrl: null, status: null, overlayText: null };
  }
  await page.waitForLoadState('networkidle', { timeout: SETTLE_TIMEOUT_MS }).catch(() => undefined);
  await page
    // An expression, since the daemon is typed without the DOM.
    .waitForFunction("document.fonts.status === 'loaded'", undefined, {
      timeout: SETTLE_TIMEOUT_MS,
    })
    .catch(() => undefined);
  return { error: null, landedUrl: page.url(), status, overlayText: await overlayOn(page) };
}

/**
 * Runs `fn` in a fresh context with the proxy letting `appUrl` through, closing the context when it
 * ends or `signal` aborts. Every context refuses downloads, blocks service workers and records nothing.
 */
async function inContext<T>(
  browser: Browser,
  proxy: AppProxy,
  appUrl: AppUrl,
  signal: AbortSignal,
  logger: Logger,
  options: Parameters<Browser['newContext']>[0],
  fn: (context: BrowserContext) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  proxy.allow(appUrl);
  const context = await browser.newContext({
    ...options,
    acceptDownloads: false,
    serviceWorkers: 'block',
  });
  const stop = (): void => {
    void context.close().catch(() => undefined);
  };
  signal.addEventListener('abort', stop, { once: true });
  try {
    await guard(context, appUrl, logger);
    const result = await fn(context);
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener('abort', stop);
    await context.close().catch(() => undefined);
  }
}

/** The camera on the daemon's pinned Chromium. One shot or sign-in runs at a time (`BrowserHost.use`). */
export function createPlaywrightCamera(host: BrowserHost<Browser>, logger: Logger): PageCamera {
  const log = logger.child({ module: 'pictures' });
  return {
    async shoot({ appUrl, route, viewport, theme, storageState, signal }) {
      const failed = (reason: string, landedUrl: string | null = null): Shot => ({
        outcome: ShotOutcome.Failed,
        png: null,
        width: viewport.width,
        height: viewport.height,
        landedUrl,
        overlayText: null,
        reason,
      });
      const url = routeUrl(appUrl, route);
      if (url === null) return failed(`${route} is not a route on ${appUrl}`);
      return host.use((browser, proxy) =>
        inContext(
          browser,
          proxy,
          appUrl,
          signal,
          log,
          {
            viewport: { width: viewport.width, height: viewport.height },
            deviceScaleFactor: 1,
            colorScheme: theme === ScreenTheme.Default ? null : theme,
            reducedMotion: 'reduce',
            ...(storageState === null ? {} : { storageState }),
          },
          async (context) => {
            const page = await context.newPage();
            const loaded = await load(page, url);
            const { outcome, reason } = shotOutcome(appUrl, route, loaded);
            if (outcome !== ShotOutcome.Clean && outcome !== ShotOutcome.Overlay) {
              return { ...failed(reason ?? '', loaded.landedUrl), outcome };
            }
            const png = await page.screenshot({
              type: 'png',
              animations: 'disabled',
              caret: 'hide',
              scale: 'css',
            });
            return {
              outcome,
              png: new Uint8Array(png),
              width: viewport.width,
              height: viewport.height,
              landedUrl: loaded.landedUrl,
              overlayText: outcome === ShotOutcome.Overlay ? loaded.overlayText : null,
              reason: null,
            };
          },
        ),
      );
    },

    async signIn({ appUrl, url, signal }) {
      let target: URL;
      try {
        target = new URL(url, appUrl);
      } catch {
        throw new SignInError('the dev login printed no address on the app');
      }
      if (target.origin !== appUrl) {
        throw new SignInError(`the dev login's address is not on ${appUrl}`);
      }
      return host.use((browser, proxy) =>
        inContext(browser, proxy, appUrl, signal, log, {}, async (context) => {
          const page = await context.newPage();
          let response: Response | null;
          try {
            response = await page.goto(target.href, {
              waitUntil: 'load',
              timeout: LOAD_TIMEOUT_MS,
            });
          } catch (error) {
            throw new SignInError(`the dev login's address did not load: ${loadFailure(error)}`);
          }
          if (unanswered(response)) throw new SignInError(APP_DID_NOT_ANSWER);
          const status = response?.status() ?? null;
          if (status !== null && status >= 500) {
            throw new SignInError(`the dev login's address answered ${String(status)}`);
          }
          await page
            .waitForLoadState('networkidle', { timeout: SETTLE_TIMEOUT_MS })
            .catch(() => undefined);
          let landed: string;
          try {
            landed = new URL(page.url()).origin;
          } catch {
            landed = page.url();
          }
          if (landed !== appUrl) {
            throw new SignInError(`the sign-in left the app's address for ${landed}`);
          }
          // Playwright's own output, read as any file from disk is.
          return StorageState.parse(await context.storageState());
        }),
      );
    },

    status: () => host.status(),
    close: () => host.close(),
  };
}
