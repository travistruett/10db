import { execFile } from 'node:child_process';
import {
  FigmaFile,
  FigmaFrame,
  InvalidError,
  UpstreamError,
  FigmaAction,
  figmaFileKey,
  figmaFrameKey,
  mockupDocument,
  ShapeMessageAuthor,
  ShapeMessageKind,
  type ConversationItemId,
  type ProjectId,
  type ShapeAttachmentId,
  type ShapeId,
} from '@10db/contracts';
import {
  getAppSetting,
  insertShapeAttachment,
  insertShapeMessage,
  listShapeAttachments,
  setAppSetting,
  type DbReader,
  type ShapeAttachmentRow,
} from '@10db/db';
import { z } from 'zod';
import type { StateStore } from '../events';

// The Figma round trip of a Plan mock-up. `html_to_figma` (the agent's Figma server) hands back a one-time
// upload address; the agent gives it to `send_mockup_to_figma`, and the daemon posts the mock-up it stored.
// What comes back from Figma is turned into plain HTML by the agent, and `file_figma_version` files it,
// with Figma's short-lived asset links replaced by the images themselves.

const SEND_TIMEOUT_MS = 60_000;
const ASSET_TIMEOUT_MS = 20_000;
const ASSET_MAX_BYTES = 5 * 1024 * 1024;
const ASSETS_MAX_COUNT = 30;
const ASSETS_MAX_BYTES = 10 * 1024 * 1024;
/** How long a press stands when no turn ends it. */
export const FIGMA_PRESS_TTL_MS = 15 * 60_000;

const SUBMIT_HOST = 'mcp.figma.com';
const SUBMIT_PATH = /^\/mcp\/html_to_figma\/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\/submit$/i;
const ASSET_URL = /https:\/\/www\.figma\.com\/api\/mcp\/asset\/[0-9a-f-]+\.(?:svg|png)/gi;
const ASSET_TYPES: Readonly<Record<string, string>> = { svg: 'image/svg+xml', png: 'image/png' };

const SubmitAnswer = z.looseObject({
  success: z.boolean(),
  fileUrl: z.string(),
  nodeIds: z.array(z.string().min(1)).min(1),
});

/** A mock-up's stored frame, or null when it has none or the stored value is malformed. */
export function frameOf(db: DbReader, attachmentId: ShapeAttachmentId): FigmaFrame | null {
  const parsed = FigmaFrame.safeParse(getAppSetting(db, figmaFrameKey(attachmentId)));
  return parsed.success ? parsed.data : null;
}

/** A project's stored draft file, or null. */
export function fileOf(db: DbReader, projectId: ProjectId): FigmaFile | null {
  const parsed = FigmaFile.safeParse(getAppSetting(db, figmaFileKey(projectId)));
  return parsed.success ? parsed.data : null;
}

/** Whether a link is a Figma design on `www.figma.com`, the only kind 10db opens. */
export function isFigmaDesignUrl(url: string): boolean {
  return designFileKey(url) !== null;
}

/** The file key in `https://www.figma.com/design/<key>/…`, or null for any other address. */
function designFileKey(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.host !== 'www.figma.com') return null;
    if (parsed.username !== '' || parsed.password !== '') return null;
    const [, design, key] = parsed.pathname.split('/');
    return design === 'design' && key !== undefined && key !== '' ? key : null;
  } catch {
    return null;
  }
}

/** The upload address, when it is Figma's `html_to_figma` submit address; the query string is kept. */
function checkedSubmitUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InvalidError('submitUrl is not a web address');
  }
  if (
    url.protocol !== 'https:' ||
    url.host !== SUBMIT_HOST ||
    url.username !== '' ||
    url.password !== '' ||
    !SUBMIT_PATH.test(url.pathname)
  )
    throw new InvalidError(
      `submitUrl must be the address html_to_figma returned (https://${SUBMIT_HOST}/mcp/html_to_figma/<id>/submit)`,
    );
  return url.href;
}

/** Opens a page in the builder's browser with `/usr/bin/open`. */
export function openWithSystem(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/open', [url], (error) => {
      if (error === null) resolve();
      else reject(error instanceof Error ? error : new Error('open failed'));
    });
  });
}

/**
 * The builder's presses. A press of Open in Figma or Bring Back from Figma leaves one mark for its mock-up
 * and action; the matching tool runs only by taking it, once, before it sends or fetches anything, so an
 * agent can never send or file on its own and one press is one attempt. The mark stays, spent, until its
 * turn ends (the row shows the press as pending meanwhile), and lapses after 15 minutes in any case. Kept
 * in memory: a press lost to a restart is pressed again.
 */
export interface FigmaPresses {
  /** Records a press whose ask is the conversation item `itemId`. */
  add(
    shapeId: ShapeId,
    attachmentId: ShapeAttachmentId,
    action: FigmaAction,
    itemId: ConversationItemId,
  ): void;
  /** Checks and spends a live, unspent press of `action` in one step; false when there is none. */
  take(shapeId: ShapeId, attachmentId: ShapeAttachmentId, action: FigmaAction): boolean;
  /** The action pressed on a mock-up and not ended yet, spent or not. */
  pending(shapeId: ShapeId, attachmentId: ShapeAttachmentId): FigmaAction | null;
  /** Drops the plan's presses whose ask `ended` names; answers whether any went. */
  endWhere(shapeId: ShapeId, ended: (itemId: ConversationItemId) => boolean): boolean;
}

export function createFigmaPresses(now: () => number): FigmaPresses {
  interface Mark {
    readonly action: FigmaAction;
    readonly at: number;
    readonly itemId: ConversationItemId;
    spent: boolean;
  }
  const marks = new Map<string, Mark>();
  const keyOf = (shapeId: ShapeId, attachmentId: ShapeAttachmentId): string =>
    `${shapeId}\0${attachmentId}`;
  const live = (key: string): Mark | null => {
    const mark = marks.get(key);
    if (mark === undefined) return null;
    if (now() - mark.at > FIGMA_PRESS_TTL_MS) {
      marks.delete(key);
      return null;
    }
    return mark;
  };
  return {
    add: (shapeId, attachmentId, action, itemId) =>
      marks.set(keyOf(shapeId, attachmentId), { action, at: now(), itemId, spent: false }),
    take(shapeId, attachmentId, action) {
      const mark = live(keyOf(shapeId, attachmentId));
      if (mark === null || mark.spent || mark.action !== action) return false;
      mark.spent = true;
      return true;
    },
    pending: (shapeId, attachmentId) => live(keyOf(shapeId, attachmentId))?.action ?? null,
    endWhere(shapeId, ended) {
      let any = false;
      for (const [key, mark] of marks)
        if (key.startsWith(`${shapeId}\0`) && ended(mark.itemId)) {
          marks.delete(key);
          any = true;
        }
      return any;
    },
  };
}

const NO_PRESS =
  'The builder starts this: they press the button on the mock-up in the Plan, and nothing was filed or sent.';

export interface FigmaDeps {
  readonly state: StateStore;
  readonly fetch: typeof fetch;
  readonly presses: FigmaPresses;
}

async function assetDataUri(
  fetchFn: typeof fetch,
  url: string,
  budget: { left: number },
): Promise<string> {
  const type = ASSET_TYPES[url.slice(url.lastIndexOf('.') + 1).toLowerCase()];
  if (type === undefined) throw new InvalidError(`${url} is not an image 10db can inline`);
  let bytes: Uint8Array;
  try {
    const response = await fetchFn(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(ASSET_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`answered ${String(response.status)}`);
    const length = Number(response.headers.get('content-length') ?? '0');
    if (length > ASSET_MAX_BYTES) throw new Error('is over 5 MB');
    bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > ASSET_MAX_BYTES) throw new Error('is over 5 MB');
    budget.left -= bytes.byteLength;
    if (budget.left < 0) throw new Error('takes the assets past 10 MB together');
  } catch (error) {
    const why = error instanceof Error ? error.message : 'could not be read';
    throw new UpstreamError(`The Figma asset ${url} ${why}; nothing was filed.`);
  }
  return `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;
}

/** The two Figma tools of a Plan session in `projectId`. */
export function createFigmaTools(deps: FigmaDeps, projectId: ProjectId) {
  const { state } = deps;
  const mockupOf = (shapeId: ShapeId, id: ShapeAttachmentId): ShapeAttachmentRow => {
    const row = listShapeAttachments(state.db, shapeId).find((a) => a.id === id);
    if (row?.kind !== 'mockup') throw new InvalidError(`${id} is not a mock-up of this Plan`);
    return row;
  };
  const line = (shapeId: ShapeId, body: string): void => {
    state.write((ctx) => {
      insertShapeMessage(ctx, shapeId, {
        author: ShapeMessageAuthor.Claude,
        kind: ShapeMessageKind.Tool,
        body,
      });
    });
  };
  return {
    /** Posts a mock-up's stored HTML to the upload address and keeps the frame link it answers. */
    async send(
      shapeId: ShapeId,
      input: { readonly attachmentId: ShapeAttachmentId; readonly submitUrl: string },
    ): Promise<{ readonly fileUrl: string; readonly nodeId: string }> {
      const row = mockupOf(shapeId, input.attachmentId);
      const url = checkedSubmitUrl(input.submitUrl);
      // One press is one attempt: it is spent here, before anything is posted.
      if (!deps.presses.take(shapeId, row.id, FigmaAction.Open)) throw new InvalidError(NO_PRESS);
      let answer: z.infer<typeof SubmitAnswer>;
      try {
        const response = await deps.fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'text/html' },
          body: mockupDocument(row.body),
          redirect: 'error',
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`answered ${String(response.status)}`);
        // Figma's reply is a boundary: only what is read here is trusted.
        answer = SubmitAnswer.parse(await response.json());
      } catch (error) {
        const why = error instanceof Error ? error.message : 'did not answer';
        line(shapeId, `send_mockup_to_figma · refused · ${why}`);
        throw new UpstreamError(`Figma did not take the mock-up: ${why}`);
      }
      const fileKey = designFileKey(answer.fileUrl);
      const nodeId = answer.nodeIds[0];
      if (!answer.success || fileKey === null || nodeId === undefined)
        throw new UpstreamError('Figma answered without a frame link for the mock-up');
      // The project's draft file is the first one a send made; a later answer from another file is refused.
      const kept = fileOf(state.db, projectId);
      if (kept !== null && kept.fileKey !== fileKey)
        throw new UpstreamError(
          `Figma answered with another file than this project's draft file, so nothing was kept.`,
        );
      state.write((ctx) => {
        setAppSetting(ctx, figmaFrameKey(row.id), { fileKey, nodeId, fileUrl: answer.fileUrl });
        if (kept === null) setAppSetting(ctx, figmaFileKey(projectId), { fileKey });
        insertShapeMessage(ctx, shapeId, {
          author: ShapeMessageAuthor.Claude,
          kind: ShapeMessageKind.Tool,
          body: `send_mockup_to_figma · ${row.key} · ${answer.fileUrl}`,
        });
      });
      return { fileUrl: answer.fileUrl, nodeId };
    },

    /** Files HTML read back from a frame as a new mock-up on the same key and target, with its frame link. */
    async fileVersion(
      shapeId: ShapeId,
      input: { readonly attachmentId: ShapeAttachmentId; readonly html: string },
    ): Promise<{ readonly attachmentId: ShapeAttachmentId; readonly fileUrl: string }> {
      const row = mockupOf(shapeId, input.attachmentId);
      const frame = frameOf(state.db, row.id);
      if (frame === null)
        throw new InvalidError(
          'That mock-up was never sent to Figma, so there is no frame to bring back.',
        );
      const urls = [...new Set(input.html.match(ASSET_URL) ?? [])];
      if (urls.length > ASSETS_MAX_COUNT)
        throw new InvalidError(
          `The HTML names ${String(urls.length)} Figma assets; at most ${String(ASSETS_MAX_COUNT)} are inlined, so nothing was filed.`,
        );
      if (!deps.presses.take(shapeId, row.id, FigmaAction.BringBack))
        throw new InvalidError(NO_PRESS);
      const uris = new Map<string, string>();
      const budget = { left: ASSETS_MAX_BYTES };
      for (const url of urls) uris.set(url, await assetDataUri(deps.fetch, url, budget));
      const html = input.html.replace(ASSET_URL, (url) => uris.get(url) ?? url);
      const made = state.write((ctx) => {
        const next = insertShapeAttachment(ctx, {
          shapeId,
          kind: 'mockup',
          key: row.key,
          body: html,
          goalId: row.goalId,
          taskId: row.taskId,
        });
        setAppSetting(ctx, figmaFrameKey(next.id), frame);
        insertShapeMessage(ctx, shapeId, {
          author: ShapeMessageAuthor.Claude,
          kind: ShapeMessageKind.Tool,
          body: `file_figma_version · mockup · ${row.key}`,
        });
        return next;
      });
      return { attachmentId: made.id, fileUrl: frame.fileUrl };
    },
  };
}
