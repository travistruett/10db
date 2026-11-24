import {
  BROWSER_TOOL_DESCRIPTIONS,
  BrowserToolInputs,
  BrowserToolName,
  EvidenceKind,
  PageRoute,
  ScreenKind,
  ScreenTheme,
  ScreenViewport,
  type BrowserAnswer,
  type SessionId,
} from '@10db/contracts';
import { insertEvidence, insertTaskScreen } from '@10db/db';
import type { z } from 'zod';
import { imagesWithinBudget } from '../conversation';
import type { StateStore } from '../events';
import { LaneBrowserError, type LaneBrowserSession } from '../lane-browser';
import { DeadlineError, pngSize, removeUnnamed, writePicture, type Pictures } from '../pictures';
import { readUploads, writeScreenCopy } from './browser-files';
import { lanePicturesSpent, sessionPictureLimits } from './picture-spend';
import { ToolImages } from './tool-images';
import type { McpDeps } from './tools';

const URL_MAX = 2048;
const TITLE_MAX = 512;

/** What the lane is told when a call can't run: an answer, not a failure, so the lane goes on. */
const isRefusal = (error: unknown): error is LaneBrowserError | DeadlineError =>
  error instanceof LaneBrowserError || error instanceof DeadlineError;

/** The page's origin and path only: no query reaches the task, the drawer or Linear. */
function cleanUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin === 'null' ? `${parsed.protocol}//` : parsed.origin}${parsed.pathname}`.slice(
      0,
      URL_MAX,
    );
  } catch {
    return url.split(/[?#]/)[0]?.slice(0, URL_MAX) ?? '';
  }
}

function routeOf(url: string): string {
  try {
    const path = new URL(url).pathname.slice(0, TITLE_MAX);
    return PageRoute.safeParse(path).success ? path : '/';
  } catch {
    return '/';
  }
}

const clamp = (n: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(n)));

/** The five tools as the lane endpoint registers them; empty when the session has no lane sandbox. */
export function browserTools(deps: {
  readonly state: StateStore;
  readonly dataDir: string;
  readonly laneBrowser: NonNullable<McpDeps['laneBrowser']>;
  readonly pictures: Pick<Pictures, 'bytesOf'> | undefined;
  readonly sessionId: SessionId;
  readonly signal: AbortSignal | undefined;
}): {
  readonly name: BrowserToolName;
  readonly description: string;
  readonly schema: z.ZodType;
  run(input: unknown): Promise<BrowserAnswer | ToolImages | string>;
}[] {
  const session = deps.laneBrowser.sessionOf(deps.sessionId);
  if (session === undefined) return [];
  const signal = deps.signal ?? new AbortController().signal;
  const { browsers } = deps.laneBrowser;

  /** A page tool: the driver's answer with the proxy's refusals and the browser's notes joined in. */
  const page = async (
    call: (driver: Parameters<Parameters<typeof browsers.use>[2]>[0]) => Promise<BrowserAnswer>,
  ): Promise<BrowserAnswer | string> => {
    try {
      return await browsers.use(session, signal, async (driver, proxy, notes) => {
        const answer = await call(driver);
        return {
          ...answer,
          refused: [...answer.refused, ...proxy.takeRefused()],
          notes: [...answer.notes, ...notes],
        };
      });
    } catch (error) {
      if (isRefusal(error)) return error.message;
      throw error;
    }
  };

  const screenshot = (input: z.output<(typeof BrowserToolInputs)['browser_screenshot']>) =>
    takeScreenshot(deps, session, signal, input);

  return [
    {
      name: BrowserToolName.Open,
      run: (input: unknown) => {
        const { url, viewport } = BrowserToolInputs[BrowserToolName.Open].parse(input);
        return page((driver) => driver.open(url, viewport, signal));
      },
    },
    {
      name: BrowserToolName.Snapshot,
      run: (input: unknown) => {
        BrowserToolInputs[BrowserToolName.Snapshot].parse(input);
        return page((driver) => driver.snapshot(signal));
      },
    },
    {
      name: BrowserToolName.Act,
      run: (input: unknown) => {
        const act = BrowserToolInputs[BrowserToolName.Act].parse(input);
        return page((driver) => driver.act(act, signal));
      },
    },
    {
      name: BrowserToolName.Upload,
      run: (input: unknown) => {
        const { ref, paths } = BrowserToolInputs[BrowserToolName.Upload].parse(input);
        const read = readUploads(paths, session);
        if ('refused' in read)
          return Promise.resolve(`Refused, and nothing was uploaded: ${read.refused}`);
        return page((driver) => driver.upload(ref, read.files, signal));
      },
    },
    {
      name: BrowserToolName.Screenshot,
      run: (input: unknown) =>
        screenshot(BrowserToolInputs[BrowserToolName.Screenshot].parse(input)),
    },
  ].map((tool) => ({
    ...tool,
    description: BROWSER_TOOL_DESCRIPTIONS[tool.name],
    schema: BrowserToolInputs[tool.name],
  }));
}

async function takeScreenshot(
  deps: Parameters<typeof browserTools>[0],
  session: LaneBrowserSession,
  signal: AbortSignal,
  input: z.output<(typeof BrowserToolInputs)['browser_screenshot']>,
): Promise<ToolImages | string> {
  const db = deps.state.db;
  let taken;
  let notes: string[];
  let refused: string[];
  try {
    ({ taken, notes, refused } = await deps.laneBrowser.browsers.use(
      session,
      signal,
      async (driver, proxy, extra) => ({
        taken: await driver.screenshot(input.fullPage === true, signal),
        notes: extra,
        refused: proxy.takeRefused(),
      }),
    ));
  } catch (error) {
    if (isRefusal(error)) return error.message;
    throw error;
  }

  const size = pngSize(taken.png);
  if (size === null)
    return 'The screenshot was not kept: the browser answered a picture that is not a PNG';
  const url = cleanUrl(taken.url);
  const title = taken.title.slice(0, TITLE_MAX);
  const note = input.note ?? null;
  const viewport = ScreenViewport.parse({
    width: clamp(taken.viewport.width, 320, 3840),
    height: clamp(taken.viewport.height, 320, 2400),
  });

  // The model's budget, decided before the write: the row records whether the picture went as an image.
  const limits = sessionPictureLimits(db, deps.sessionId);
  const spent = lanePicturesSpent(
    db,
    deps.pictures?.bytesOf ?? (() => 0),
    session.taskId,
    deps.sessionId,
  );
  let why: string | null = null;
  if (limits.imageMaxBytes === 0) {
    why = "this account's model takes no pictures; open the path";
  } else if (Math.max(size.width, size.height) > limits.imageMaxSide) {
    why = `the picture is ${String(size.width)} x ${String(size.height)}, over the ${String(limits.imageMaxSide)} px side an image may have; open the path`;
  } else if (imagesWithinBudget([taken.png.length], spent, limits).length === 0) {
    why = `this session's picture budget (${limits.limitText}) is used up; open the path`;
  }
  const sent = why === null;

  let screenId;
  let file;
  try {
    file = writePicture(deps.dataDir, taken.png);
  } catch (error) {
    return `The screenshot was not kept: ${error instanceof Error ? error.message : 'the file was not written'}`;
  }
  try {
    screenId = deps.state.write((ctx) => {
      const screen = insertTaskScreen(ctx, {
        taskId: session.taskId,
        turnId: null,
        kind: ScreenKind.Lane,
        route: routeOf(taken.url),
        viewport,
        theme: ScreenTheme.Default,
        sha256: file.sha256,
        size: taken.png.length,
        width: size.width,
        height: size.height,
        storedPath: file.storedPath,
        keptSha: null,
        lane: { url, title, note, sentSessionId: sent ? deps.sessionId : null },
      });
      if (screen === null) throw new LaneBrowserError('the picture was not recorded');
      insertEvidence(ctx, {
        workstreamId: session.workstreamId,
        kind: EvidenceKind.Browser,
        command: null,
        exitCode: null,
        logPath: null,
        commitShas: [],
        screenId: screen.id,
        summary: `Screenshot of ${url} (${title})${note === null ? '' : `: ${note}`}`,
      });
      return screen.id;
    });
  } catch (error) {
    removeUnnamed(db, deps.dataDir, file.sha256);
    return `The screenshot was not kept: ${error instanceof Error ? error.message : 'the write failed'}`;
  }

  const copy = writeScreenCopy(session.tempDir, screenId, taken.png);
  const answer = {
    screenId,
    path: copy.path,
    url,
    title,
    sent,
    why: why ?? ('why' in copy ? copy.why : null),
    ...(notes.length > 0 ? { notes } : {}),
    ...(refused.length > 0 ? { refused } : {}),
  };
  return new ToolImages(
    JSON.stringify(answer),
    sent ? [{ mediaType: 'image/png', data: Buffer.from(taken.png).toString('base64') }] : [],
  );
}
