import { readFile } from 'node:fs/promises';
import {
  LinearEventKind,
  LinearPostState,
  type LinearPostDto,
  type TaskId,
  type TaskScreenId,
} from '@10db/contracts';
import {
  getTask,
  getTaskScreenRow,
  listLinearPosts,
  listTaskScreens,
  type DbReader,
} from '@10db/db';
import { z } from 'zod';
import { picturePlan } from '../delivery';
import type { PicturesOutlook } from '../pictures';
import { LOCAL_LANDING } from './reporter-events';

// A finished task's before and after pictures go into its `ended` comment on the Linear issue (its
// `pr_merged` comment when the `ended` one carried none), the pairs its pull request and Slack show. 10db
// uploads them itself, through the same Linear sign-in that writes the comment: the agent hands over words only.
// A task that took none says so once, with the reason, and never points at a pull request, which a project
// that commits directly has none of.

/** The most pictures one comment carries; the rest are left in 10db. */
export const MAX_LINEAR_PICTURES = 6;

/** One picture to upload: the row it is, the file name it is uploaded as and what it shows. */
export interface ReporterPicture {
  readonly id: TaskScreenId;
  readonly name: string;
  readonly label: string;
}

/** The task's before and after pairs, before first, at most `MAX_LINEAR_PICTURES`; and how many did not fit. */
export function reporterPictures(
  db: DbReader,
  taskId: TaskId,
): { readonly pictures: ReporterPicture[]; readonly more: number } {
  const all = picturePlan([
    { title: getTask(db, taskId).title, screens: listTaskScreens(db, taskId) },
  ])
    .flatMap((pair) => [
      pair.before === null ? null : { kind: 'Before', route: pair.route, picture: pair.before },
      pair.after === null ? null : { kind: 'After', route: pair.route, picture: pair.after },
    ])
    .flatMap((p) => (p === null ? [] : [p]))
    .map((p) => ({
      id: p.picture.screen.id,
      name: p.picture.name,
      label: `${p.kind}, ${p.route}`,
    }));
  return {
    pictures: all.slice(0, MAX_LINEAR_PICTURES),
    more: Math.max(0, all.length - MAX_LINEAR_PICTURES),
  };
}

/** Google Cloud Storage, where Linear's signed upload URLs point. */
const UPLOAD_HOST = 'storage.googleapis.com';
const UPLOAD_BUCKET_PREFIX = '/linear-uploads';
/** The account that signs Linear's upload URLs; storage refuses a URL it did not sign. */
const LINEAR_SIGNER = 'linear-server@linear-1.iam.gserviceaccount.com/';

/**
 * Whether a URL is one Linear signed for an upload: https on Linear's storage bucket, signed by Linear's own
 * account. A picture is never sent anywhere else.
 */
export function isLinearUploadUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  // Each signing parameter appears exactly once, so storage can't read a different one than this check did.
  const one = (name: string): string | null => {
    const values = url.searchParams.getAll(name);
    return values.length === 1 ? (values[0] ?? null) : null;
  };
  return (
    url.protocol === 'https:' &&
    url.host === UPLOAD_HOST &&
    url.username === '' &&
    url.password === '' &&
    url.pathname.startsWith(UPLOAD_BUCKET_PREFIX) &&
    one('X-Goog-Algorithm') !== null &&
    one('X-Goog-Signature') !== null &&
    (one('X-Goog-Credential') ?? '').startsWith(LINEAR_SIGNER)
  );
}

/** The headers Linear signs or sets on an upload; any other header is dropped. */
const UPLOAD_HEADERS: ReadonlySet<string> = new Set([
  'content-type',
  'cache-control',
  'content-disposition',
]);

const uploadHeaders = (headers: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(headers).filter(([name]) => {
      const lower = name.toLowerCase();
      return UPLOAD_HEADERS.has(lower) || lower.startsWith('x-goog-');
    }),
  );

export class LinearUploadError extends Error {
  override readonly name = 'LinearUploadError';
}

const UPLOAD_TIMEOUT_MS = 30_000;

/** What Linear's `prepare_file_upload` answers, read from its text: where to send the file and how to show it. */
const PreparedUpload = z.object({
  uploadRequest: z.object({
    url: z.string(),
    headers: z.union([
      z.record(z.string(), z.string()),
      z
        .array(z.object({ key: z.string(), value: z.string() }))
        .transform((pairs) => Object.fromEntries(pairs.map((p) => [p.key, p.value]))),
    ]),
  }),
  markdown: z.string().optional(),
  assetUrl: z.string().optional(),
});

/** The signed upload and the markdown that shows the file once it is sent. */
export interface PreparedPicture {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly markdown: string;
  readonly assetUrl: string | null;
}

/** Reads `prepare_file_upload`'s answer; throws a `LinearUploadError` naming what is missing. */
export function parsePreparedPicture(text: string, name: string): PreparedPicture {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new LinearUploadError("Linear's answer to the upload request was not JSON.");
  }
  const parsed = PreparedUpload.safeParse(json);
  if (!parsed.success)
    throw new LinearUploadError("Linear's answer to the upload request has no upload address.");
  const { uploadRequest, markdown, assetUrl } = parsed.data;
  const shown = markdown ?? (assetUrl === undefined ? null : `![${name}](${assetUrl})`);
  if (shown === null)
    throw new LinearUploadError("Linear's answer to the upload request has no picture address.");
  return {
    url: uploadRequest.url,
    headers: uploadRequest.headers,
    markdown: shown,
    assetUrl: assetUrl ?? null,
  };
}

/** Linear's way to prepare an upload, from the sign-in 10db writes comments with. */
export interface PictureUploader {
  preparePicture(input: {
    readonly filename: string;
    readonly size: number;
  }): Promise<PreparedPicture>;
}

/** Sends a picture's bytes to a signed upload URL, the signed headers exactly as Linear returned them. */
async function sendPicture(
  prepared: PreparedPicture,
  bytes: Uint8Array,
  send: typeof fetch,
): Promise<void> {
  if (!isLinearUploadUrl(prepared.url))
    throw new LinearUploadError('Linear gave an upload address it did not sign.');
  let response: Response;
  try {
    response = await send(prepared.url, {
      method: 'PUT',
      headers: uploadHeaders(prepared.headers),
      body: Uint8Array.from(bytes),
      redirect: 'error',
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    throw new LinearUploadError(
      `The upload did not reach Linear: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok)
    throw new LinearUploadError(`Linear refused the upload with HTTP ${String(response.status)}.`);
}

/** The pictures that reached Linear, each with the markdown that shows it, and why the others did not. */
export interface UploadedPictures {
  readonly shown: readonly {
    readonly label: string;
    readonly markdown: string;
    readonly assetUrl: string | null;
  }[];
  readonly failed: readonly string[];
}

/**
 * Uploads each picture one at a time (a signed URL lasts a minute, so each is prepared just before it is sent).
 * A picture whose file is gone, or that Linear refuses, is left out and named; a Linear that is down or refuses
 * its sign-in ends the run, since the rest would fail the same way.
 */
export async function uploadPictures(
  db: DbReader,
  pictures: readonly ReporterPicture[],
  uploader: PictureUploader,
  send: typeof fetch,
): Promise<UploadedPictures> {
  const shown: { label: string; markdown: string; assetUrl: string | null }[] = [];
  const failed: string[] = [];
  for (const picture of pictures) {
    let bytes: Uint8Array;
    try {
      bytes = await readFile(getTaskScreenRow(db, picture.id).storedPath);
    } catch {
      failed.push(`${picture.label} is no longer kept`);
      continue;
    }
    try {
      const prepared = await uploader.preparePicture({
        filename: picture.name,
        size: bytes.length,
      });
      await sendPicture(prepared, bytes, send);
      shown.push({
        label: picture.label,
        markdown: prepared.markdown,
        assetUrl: prepared.assetUrl,
      });
    } catch (error) {
      failed.push(`${picture.label}: ${error instanceof Error ? error.message : String(error)}`);
      break;
    }
  }
  return { shown, failed };
}

/** The part of a comment that shows the pictures, or says why there are none. */
export function picturesText(input: {
  readonly uploaded: UploadedPictures;
  readonly more: number;
  readonly offered: number;
}): string {
  const { uploaded, more, offered } = input;
  const lines: string[] = [];
  if (uploaded.shown.length > 0) {
    lines.push('**Pictures**');
    for (const picture of uploaded.shown) lines.push('', picture.label, picture.markdown);
  }
  const left = more + (offered - uploaded.shown.length);
  if (left > 0)
    lines.push(
      '',
      `${String(left)} more ${left === 1 ? 'picture is' : 'pictures are'} in 10db${
        uploaded.failed.length === 0
          ? '.'
          : `, which did not upload (${uploaded.failed.join('; ')}).`
      }`,
    );
  return lines.join('\n');
}

/** The one line that says a task has no pictures, and why. Never names a pull request. */
export const skippedText = (reason: string): string =>
  `No before and after pictures were taken. ${reason}.`;

/** Said once, when the pictures exist but this account's Linear sign-in is not one 10db can upload with. */
export const NOT_UPLOADABLE_TEXT =
  "The before and after pictures are in 10db: this account's Linear sign-in is held by its agent, so 10db can't upload them here.";

/** Said on the `ended` comment of a local copy's task, whose after is taken once its change lands. */
export const LATER_TEXT =
  'The before and after pictures follow in a comment when the change lands in the project.';

/** Said when the pictures were still being taken as the comment was written. */
export const STILL_TAKING_TEXT =
  'The before and after pictures were still being taken when this was written; they are in 10db once done.';

/** Whether an owed update waits for its task's pictures: it carries them, or the word on why it has none. */
export const carriesPictures = (event: LinearEventKind): boolean =>
  event === LinearEventKind.Ended ||
  event === LinearEventKind.PrMerged ||
  event === LinearEventKind.Landed;

/**
 * What an owed update adds to its comment, and the first picture's address to record on its row. Pictures go in
 * the `ended` comment, or in the `pr_merged` or `landed` one when none showed before. What there is to say about missing
 * ones is said once: on the first `ended` comment, or, for a local copy (whose `ended` comment says they follow),
 * on its landing comment.
 */
export async function picturesFor(input: {
  readonly db: DbReader;
  readonly post: Pick<LinearPostDto, 'id' | 'event' | 'taskId' | 'detail'>;
  /** Null when 10db can't sign in to Linear itself: the pictures can't be uploaded. */
  readonly uploader: PictureUploader | null;
  readonly outlook: (taskId: TaskId) => PicturesOutlook;
  readonly send: typeof fetch;
}): Promise<{ readonly text: string; readonly attachmentUrl: string | null }> {
  const { db, post } = input;
  const none = { text: '', attachmentUrl: null };
  if (!carriesPictures(post.event)) return none;
  const earlier = listLinearPosts(db, post.taskId).filter(
    (p) => p.id !== post.id && p.state === LinearPostState.Recorded,
  );
  if (earlier.some((p) => p.attachmentUrl !== null)) return none;
  const speaks =
    post.event === LinearEventKind.Ended
      ? !earlier.some((p) => p.event === LinearEventKind.Ended)
      : post.detail[LOCAL_LANDING] === true;
  const { pictures, more } = reporterPictures(db, post.taskId);
  if (pictures.length === 0) {
    if (!speaks) return none;
    const outlook = input.outlook(post.taskId);
    const text =
      outlook.kind === 'skipped'
        ? skippedText(outlook.reason)
        : outlook.kind === 'wait'
          ? STILL_TAKING_TEXT
          : outlook.kind === 'later' && post.event === LinearEventKind.Ended
            ? LATER_TEXT
            : '';
    return { text, attachmentUrl: null };
  }
  if (input.uploader === null)
    return { text: speaks ? NOT_UPLOADABLE_TEXT : '', attachmentUrl: null };
  const uploaded = await uploadPictures(db, pictures, input.uploader, input.send);
  return {
    text: picturesText({ uploaded, more, offered: pictures.length }),
    attachmentUrl: uploaded.shown[0]?.assetUrl ?? uploaded.shown[0]?.markdown ?? null,
  };
}
