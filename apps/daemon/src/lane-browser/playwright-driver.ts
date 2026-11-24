import {
  BROWSER_MAX_PAGES,
  SNAPSHOT_MAX_CHARS,
  type BrowserAnswer,
  type BrowserDialog,
  type ScreenViewport,
} from '@10db/contracts';
import type { Browser, BrowserContext, Dialog, Page, Request, Response } from 'playwright-core';
import type { Clock } from '../clock';
import { BrowserStuckError, launchChromium, withDeadline } from '../pictures';
import type { LaneDriver, LaunchLaneDriver, UploadFile } from './driver';
import { laneUrlTarget } from './lane-reach';

/** What is left of a navigation's budget is cut by this, so the answer still has time to build. */
const NAVIGATION_RESERVE_MS = 5_000;
const NAVIGATION_MAX_MS = 55_000;
const ACTION_TIMEOUT_MS = 15_000;
const SETTLE_TIMEOUT_MS = 5_000;
const SCREENSHOT_TIMEOUT_MS = 20_000;
/** How long a page gets to answer a trivial script after a call was stopped, before it counts as stuck. */
const PROBE_MS = 3_000;
const CLOSE_PAGE_MS = 3_000;
const PROXY_REFUSAL = 'the reach rules refused it';
const VIEWPORT = { width: 1440, height: 900 } as const;
const CUT_LINE = `… cut at ${SNAPSHOT_MAX_CHARS.toLocaleString('en-US')} characters; act on what is shown or scroll first`;

/** A Playwright message's first line: no stack, no call log. */
function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n')[0]?.trim() ?? text;
}

/** `<method> <origin><path>: <why>`, never the query. */
function refusalLine(method: string, rawUrl: string, why: string): string {
  try {
    const url = new URL(rawUrl);
    const where = url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : url.protocol;
    return `${method} ${where}${url.protocol.startsWith('http') ? url.pathname : ''}: ${why}`;
  } catch {
    return `${method} (unreadable address): ${why}`;
  }
}

function isMainFrameNavigation(request: Request): boolean {
  return request.isNavigationRequest() && request.frame().parentFrame() === null;
}

/**
 * Launches the browser and drives it for one session: one context (its cookie jar until it closes),
 * at most `BROWSER_MAX_PAGES` pages, and Playwright's routing as a first check above the proxy,
 * which is what holds.
 */
export const launchPlaywrightDriver: LaunchLaneDriver = async (options, clock) => {
  const browser = await launchChromium(options);
  try {
    const context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: 'block',
      viewport: { ...VIEWPORT },
    });
    const driver = new PlaywrightLaneDriver(browser, context, clock);
    await driver.guard();
    return driver;
  } catch (error) {
    await browser.close().catch(() => undefined);
    throw error;
  }
};

class PlaywrightLaneDriver implements LaneDriver {
  private readonly browser: Browser;
  private readonly context: BrowserContext;
  private readonly clock: Clock;
  private readonly pages: Page[] = [];
  private current: Page | null = null;
  private readonly statuses = new WeakMap<Page, number | null>();
  private refused: string[] = [];
  private dialogs: BrowserDialog[] = [];
  private notes: string[] = [];
  private acceptDialog = false;
  /** Reads of the proxy's refusals still under way; an answer waits for them. */
  private readonly reading = new Set<Promise<void>>();

  constructor(browser: Browser, context: BrowserContext, clock: Clock) {
    this.clock = clock;
    this.browser = browser;
    this.context = context;
    context.on('page', (page) => {
      this.adopt(page);
    });
    context.on('response', (response) => {
      this.noteProxyRefusal(response);
    });
    context.on('requestfailed', (request) => {
      const error = request.failure()?.errorText ?? '';
      // A cross-origin fetch the proxy refused fails on CORS before any response is read, as a bare
      // `ERR_FAILED`; a tunnel the proxy refused fails by name. Both read as a refusal.
      if (error.includes('ERR_TUNNEL_CONNECTION_FAILED')) {
        this.refused.push(refusalLine(request.method(), request.url(), PROXY_REFUSAL));
      } else if (error === 'net::ERR_FAILED') {
        this.refused.push(
          refusalLine(request.method(), request.url(), `failed, perhaps ${PROXY_REFUSAL}`),
        );
      }
    });
  }

  /** Routes every request through the first check; run once, before any page exists. */
  async guard(): Promise<void> {
    await this.context.route('**/*', async (route, request) => {
      const url = request.url();
      const method = request.method();
      if (/^https?:/i.test(url)) {
        const target = laneUrlTarget(url);
        if (target.kind === 'port') {
          await route.continue();
          return;
        }
        this.refused.push(refusalLine(method, url, target.why));
        await route.abort('blockedbyclient');
        return;
      }
      if (/^(data|blob):/i.test(url) && !isMainFrameNavigation(request)) {
        await route.continue();
        return;
      }
      this.refused.push(refusalLine(method, url, 'only loopback http and https are reachable'));
      await route.abort('blockedbyclient');
    });
    await this.context.routeWebSocket(
      () => true,
      (socket) => {
        const url = socket.url();
        const target = laneUrlTarget(url.replace(/^ws/i, 'http'));
        if (target.kind === 'port') {
          socket.connectToServer();
          return;
        }
        this.refused.push(refusalLine('GET', url.replace(/^ws/i, 'http'), target.why));
        void socket.close({ code: 1008, reason: 'not reachable' });
      },
    );
  }

  private adopt(page: Page): void {
    this.pages.push(page);
    this.current = page;
    while (this.pages.length > BROWSER_MAX_PAGES) {
      const oldest = this.pages.shift();
      if (oldest === undefined) break;
      this.notes.push(
        `closed the oldest page, ${oldest.url()}: at most ${String(BROWSER_MAX_PAGES)} stay open`,
      );
      void oldest.close().catch(() => undefined);
    }
    page.on('close', () => {
      const at = this.pages.indexOf(page);
      if (at !== -1) this.pages.splice(at, 1);
      if (this.current === page) this.current = this.pages[this.pages.length - 1] ?? null;
    });
    page.on('dialog', (dialog) => {
      void this.answerDialog(dialog);
    });
    page.on('response', (response) => {
      const request = response.request();
      if (isMainFrameNavigation(request) && request.frame() === page.mainFrame()) {
        this.statuses.set(page, response.status());
      }
    });
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      const url = frame.url();
      // chrome-error: is the page the browser shows for a request that failed, already reported.
      if (url === 'about:blank' || /^(https?|chrome-error):/i.test(url)) return;
      this.refused.push(refusalLine('GET', url, 'only loopback http and https are reachable'));
      void page.goto('about:blank').catch(() => undefined);
    });
  }

  private async answerDialog(dialog: Dialog): Promise<void> {
    const type = dialog.type();
    if (type !== 'alert' && type !== 'beforeunload' && type !== 'confirm' && type !== 'prompt') {
      await dialog.dismiss().catch(() => undefined);
      return;
    }
    const accept = type === 'alert' || type === 'beforeunload' || this.acceptDialog;
    this.dialogs.push({
      type,
      message: dialog.message(),
      answer: accept ? 'accepted' : 'dismissed',
    });
    await (accept ? dialog.accept() : dialog.dismiss()).catch(() => undefined);
  }

  /** Settles with the work, or throws when the signal aborts; a page that then will not answer is stuck. */
  private async guarded<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    try {
      return await withDeadline(
        this.clock,
        NAVIGATION_MAX_MS + NAVIGATION_RESERVE_MS,
        work,
        () => undefined,
        signal,
      );
    } catch (error) {
      if (signal.aborted) await this.probe();
      throw error;
    }
  }

  private async probe(): Promise<void> {
    const page = this.current;
    if (page === null) return;
    try {
      await withDeadline(
        this.clock,
        PROBE_MS,
        () => page.evaluate('1'),
        () => undefined,
      );
    } catch {
      throw new BrowserStuckError('the page does not answer after its call was stopped');
    }
  }

  private async answer(snapshot: boolean, signal: AbortSignal): Promise<BrowserAnswer> {
    await Promise.allSettled([...this.reading]);
    const page = this.current;
    let text: string | null = null;
    let cut = false;
    if (page === null) {
      this.notes.push('no page is open; call browser_open');
    } else if (snapshot) {
      try {
        const full = await page.ariaSnapshot({ mode: 'ai', signal });
        cut = full.length > SNAPSHOT_MAX_CHARS;
        text = cut ? `${full.slice(0, SNAPSHOT_MAX_CHARS)}\n${CUT_LINE}` : full;
      } catch (error) {
        if (signal.aborted) throw error;
        this.notes.push(`the page could not be read: ${firstLine(error)}`);
      }
    }
    const pages = await Promise.all(
      this.pages.map(async (p) => ({
        url: p.url(),
        title: await p.title().catch(() => ''),
        current: p === this.current,
      })),
    );
    const answer: BrowserAnswer = {
      page:
        page === null
          ? null
          : {
              url: page.url(),
              title: await page.title().catch(() => ''),
              status: this.statuses.get(page) ?? null,
            },
      pages,
      snapshot: text,
      snapshotCut: cut,
      refused: this.refused,
      dialogs: this.dialogs,
      notes: this.notes,
    };
    this.refused = [];
    this.dialogs = [];
    this.notes = [];
    return answer;
  }

  private async openPage(): Promise<Page> {
    if (this.current !== null) return this.current;
    const page = await this.context.newPage();
    if (!this.pages.includes(page)) this.adopt(page);
    this.current = page;
    return page;
  }

  open(
    url: string,
    viewport: ScreenViewport | undefined,
    signal: AbortSignal,
  ): Promise<BrowserAnswer> {
    return this.guarded(signal, async () => {
      const target = laneUrlTarget(url);
      if (target.kind === 'refused') {
        this.refused.push(refusalLine('GET', url, target.why));
        return this.answer(false, signal);
      }
      const page = await this.openPage();
      if (viewport !== undefined) await page.setViewportSize(viewport);
      const timeout = Math.max(1_000, NAVIGATION_MAX_MS - NAVIGATION_RESERVE_MS);
      try {
        const response = await page.goto(url, { waitUntil: 'load', timeout });
        this.statuses.set(page, response?.status() ?? null);
        if (response !== null && (await this.proxyRefused(response))) {
          this.notes.push(`the browser was refused ${url}; see refused`);
        }
      } catch (error) {
        this.statuses.set(page, null);
        if (signal.aborted) throw error;
        const line = firstLine(error);
        if (line.includes('ERR_TUNNEL_CONNECTION_FAILED')) {
          this.notes.push(`the browser was refused ${url}; see refused`);
        } else {
          this.notes.push(`could not load ${url}: ${line}`);
        }
      }
      return this.answer(true, signal);
    });
  }

  /** The proxy's own 403 has no body and no content type (a body the browser blocked reads as none); an app's usually has one. */
  private async proxyRefused(response: Response): Promise<boolean> {
    if (response.status() !== 403 || response.headers()['content-type'] !== undefined) return false;
    return (await response.body().catch(() => Buffer.alloc(0))).length === 0;
  }

  private noteProxyRefusal(response: Response): void {
    if (response.status() !== 403) return;
    const reading = this.proxyRefused(response).then((refused) => {
      if (refused) {
        const request = response.request();
        this.refused.push(refusalLine(request.method(), request.url(), PROXY_REFUSAL));
      }
    });
    this.reading.add(reading);
    void reading.finally(() => this.reading.delete(reading));
  }

  snapshot(signal: AbortSignal): Promise<BrowserAnswer> {
    return this.guarded(signal, () => this.answer(true, signal));
  }

  act(input: Parameters<LaneDriver['act']>[0], signal: AbortSignal): Promise<BrowserAnswer> {
    return this.guarded(signal, async () => {
      const page = this.current;
      if (page === null) {
        this.notes.push('no page is open; call browser_open');
        return this.answer(false, signal);
      }
      this.acceptDialog = input.dialog === 'accept';
      try {
        const target = page.getByRef(input.ref);
        const options = { timeout: ACTION_TIMEOUT_MS };
        switch (input.action) {
          case 'click':
            await target.click(options);
            break;
          case 'fill':
            await target.fill(input.value ?? '', options);
            break;
          case 'select':
            await target.selectOption(input.value ?? '', options);
            break;
          case 'check':
            await target.check(options);
            break;
          case 'press':
            await target.press(input.value ?? '', options);
            break;
        }
        await page
          .waitForLoadState('domcontentloaded', { timeout: SETTLE_TIMEOUT_MS })
          .catch(() => undefined);
      } catch (error) {
        if (signal.aborted) throw error;
        this.notes.push(this.actFailure(input.ref, error));
      } finally {
        this.acceptDialog = false;
      }
      return this.answer(true, signal);
    });
  }

  private actFailure(ref: string, error: unknown): string {
    const line = firstLine(error);
    if (/ref|not found|no element|resolved to 0/i.test(line) && /e\d+|ref/i.test(line)) {
      return `ref ${ref} is not in the latest snapshot; call browser_snapshot`;
    }
    return `the action failed: ${line}`;
  }

  upload(ref: string, files: readonly UploadFile[], signal: AbortSignal): Promise<BrowserAnswer> {
    return this.guarded(signal, async () => {
      const page = this.current;
      if (page === null) {
        this.notes.push('no page is open; call browser_open');
        return this.answer(false, signal);
      }
      try {
        await page.getByRef(ref).setInputFiles(
          files.map((f) => ({ name: f.name, mimeType: f.mimeType, buffer: Buffer.from(f.buffer) })),
          { timeout: ACTION_TIMEOUT_MS },
        );
      } catch (error) {
        if (signal.aborted) throw error;
        this.notes.push(this.actFailure(ref, error));
      }
      return this.answer(true, signal);
    });
  }

  screenshot(
    fullPage: boolean,
    signal: AbortSignal,
  ): Promise<{
    readonly png: Uint8Array;
    readonly url: string;
    readonly title: string;
    readonly viewport: ScreenViewport;
  }> {
    return this.guarded(signal, async () => {
      const page = this.current;
      if (page === null) throw new Error('no page is open; call browser_open');
      const png = await page.screenshot({
        type: 'png',
        fullPage,
        animations: 'disabled',
        timeout: SCREENSHOT_TIMEOUT_MS,
      });
      return {
        png,
        url: page.url(),
        title: await page.title().catch(() => ''),
        viewport: page.viewportSize() ?? { ...VIEWPORT },
      };
    });
  }

  isConnected(): boolean {
    return this.browser.isConnected();
  }

  async close(): Promise<void> {
    await withDeadline(
      this.clock,
      CLOSE_PAGE_MS * 3,
      () => this.browser.close(),
      () => undefined,
    ).catch(() => undefined);
  }
}
