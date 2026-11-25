import { readFile } from 'node:fs/promises';
import {
  LinearEventKind,
  type LinearPostDto,
  type TaskId,
  type TaskScreenId,
} from '@10db/contracts';
import { getTask, getTaskScreenRow, listTaskScreens, type DbReader } from '@10db/db';
import { picturePlan } from '../delivery';

// A finished task's before and after pictures go into its `ended` comment on the Linear issue, the same
// pairs its pull request and Slack post show. The agent asks Linear for a signed upload URL, and 10db
// sends the file itself: the reporter's session has no network of its own, and it can only name a
// picture the brief offered, never a file.

/** The most pictures one comment carries; the rest are in the pull request. */
export const MAX_LINEAR_PICTURES = 6;

/** One picture offered to a run: its id, the file name it is uploaded as, what it shows and its exact size. */
export interface ReporterPicture {
  readonly id: TaskScreenId;
  readonly name: string;
  readonly label: string;
  readonly size: number;
}

/** The pictures a run may upload: the task's before and after pairs, and only when an `ended` update is owed. */
export function reporterPictures(
  db: DbReader,
  taskId: TaskId,
  owed: readonly Pick<LinearPostDto, 'event'>[],
): ReporterPicture[] {
  if (!owed.some((p) => p.event === LinearEventKind.Ended)) return [];
  const plan = picturePlan([
    { title: getTask(db, taskId).title, screens: listTaskScreens(db, taskId) },
  ]);
  return plan
    .flatMap((pair) => [
      pair.before === null ? null : { kind: 'Before', route: pair.route, picture: pair.before },
      pair.after === null ? null : { kind: 'After', route: pair.route, picture: pair.after },
    ])
    .flatMap((p) => (p === null ? [] : [p]))
    .slice(0, MAX_LINEAR_PICTURES)
    .map((p) => ({
      id: p.picture.screen.id,
      name: p.picture.name,
      label: `${p.kind}, ${p.route}`,
      size: p.picture.screen.size,
    }));
}

/** Google Cloud Storage, where Linear's signed upload URLs point. */
const UPLOAD_HOST = 'storage.googleapis.com';
const UPLOAD_BUCKET_PREFIX = '/linear-uploads';
/** The account that signs Linear's upload URLs; storage refuses a URL it did not sign. */
const LINEAR_SIGNER = 'linear-server@linear-1.iam.gserviceaccount.com/';

/**
 * Whether a URL is one Linear signed for an upload: https on Linear's storage bucket, signed by Linear's own
 * account. A URL signed by anyone else fails at storage, so a picture can't be sent to a bucket Linear did not
 * pick.
 */
export function isLinearUploadUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.host === UPLOAD_HOST &&
    url.username === '' &&
    url.password === '' &&
    url.pathname.startsWith(UPLOAD_BUCKET_PREFIX) &&
    (url.searchParams.get('X-Goog-Credential') ?? '').startsWith(LINEAR_SIGNER)
  );
}

export class LinearUploadError extends Error {
  override readonly name = 'LinearUploadError';
}

const UPLOAD_TIMEOUT_MS = 30_000;

/** Sends a picture's file to a signed upload URL, the signed headers exactly as Linear returned them. */
export async function uploadPicture(
  db: DbReader,
  input: {
    readonly pictureId: TaskScreenId;
    readonly uploadUrl: string;
    readonly headers: Readonly<Record<string, string>>;
  },
  send: typeof fetch,
): Promise<void> {
  if (!isLinearUploadUrl(input.uploadUrl))
    throw new LinearUploadError(
      'That is not an upload URL Linear signed. Use the uploadRequest.url prepare_file_upload returned.',
    );
  const bytes = await readFile(getTaskScreenRow(db, input.pictureId).storedPath);
  let response: Response;
  try {
    response = await send(input.uploadUrl, {
      method: 'PUT',
      headers: { ...input.headers },
      body: bytes,
      redirect: 'error',
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    throw new LinearUploadError(
      `The upload did not reach Linear: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok)
    throw new LinearUploadError(
      response.status === 403
        ? 'Linear refused the upload (403): the URL expired after 60 seconds or a header was changed. Prepare it again and upload at once.'
        : `Linear refused the upload with HTTP ${String(response.status)}.`,
    );
}
