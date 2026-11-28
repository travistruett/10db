import { readFile } from 'node:fs/promises';
import { getTaskScreenRow, type DbReader } from '@10db/db';
import { z } from 'zod';
import type { Clock } from '../clock';
import type { NamedUpload } from './reporter-guard';
import {
  LinearUploadError,
  parsePreparedPicture,
  sendPicture,
  type ReporterPicture,
  type UploadedPictures,
} from './reporter-pictures';

// A task's pictures reach Linear through a sign-in only the account's agent holds (a Codex login, a claude.ai
// connector). 10db has no header to ask Linear for an upload address with, so the agent asks: 10db names one
// file (name, type, exact size), the agent calls Linear's `prepare_file_upload` with exactly that, 10db reads
// the call's result from the session, checks the address is one Linear signed and sends the bytes itself. The
// agent has no network and never sees a picture. One file at a time, as Linear asks: the next is named only
// after the last was sent, since a signed address lasts a minute.

/** Every picture 10db takes is a PNG. */
export const PICTURE_CONTENT_TYPE = 'image/png';
/** How long 10db waits for the session to show the result of an upload request the guard let out. */
export const RESULT_WAIT_MS = 20_000;

/** The one picture an upload waits on: named to the agent, then sent once Linear's answer is read. */
interface UploadStep {
  readonly picture: ReporterPicture;
  readonly bytes: Uint8Array;
  /** What the agent's `prepare_file_upload` must carry; the guard marks it asked when it lets the call out. */
  readonly named: NamedUpload;
  /** The call's result reached 10db, or the wait for it ended: a later result is not this step's. */
  closed: boolean;
  readonly done: Promise<void>;
  readonly finish: () => void;
}

/** One owed update's pictures on their way to Linear, a file at a time. */
export interface AgentUpload {
  /** The pictures not yet named. Emptied when one fails: the rest would fail the same way. */
  readonly queue: ReporterPicture[];
  readonly offered: number;
  readonly more: number;
  /** What the comment says after its pictures, when a landing has no after to show. */
  readonly note: string;
  step: UploadStep | null;
  readonly shown: { label: string; markdown: string; assetUrl: string | null }[];
  readonly failed: string[];
}

export const beginAgentUpload = (
  pictures: readonly ReporterPicture[],
  more: number,
  note: string,
): AgentUpload => ({
  queue: [...pictures],
  offered: pictures.length,
  more,
  note,
  step: null,
  shown: [],
  failed: [],
});

/** What reached Linear and what did not, in the shape the comment's picture text reads. */
export const uploadedOf = (upload: AgentUpload): UploadedPictures => ({
  shown: upload.shown,
  failed: upload.failed,
});

const fail = (upload: AgentUpload, step: UploadStep, why: string): void => {
  upload.failed.push(`${step.picture.label}: ${why}`);
  upload.queue.length = 0;
};

/**
 * Names the next picture whose file is still kept, or null when none is left. Its size is the file's exact
 * byte count, which Linear signs into the address.
 */
export async function nameNextPicture(
  db: DbReader,
  upload: AgentUpload,
): Promise<NamedUpload | null> {
  upload.step = null;
  for (let picture = upload.queue.shift(); picture !== undefined; picture = upload.queue.shift()) {
    let bytes: Uint8Array;
    try {
      bytes = await readFile(getTaskScreenRow(db, picture.id).storedPath);
    } catch {
      upload.failed.push(`${picture.label} is no longer kept`);
      continue;
    }
    let finish = (): void => undefined;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const named: NamedUpload = {
      filename: picture.name,
      contentType: PICTURE_CONTENT_TYPE,
      size: bytes.length,
      asked: false,
    };
    upload.step = { picture, bytes, named, closed: false, done, finish };
    return named;
  }
  return null;
}

const TextBlock = z.looseObject({ type: z.literal('text'), text: z.string() });
const WithContent = z.looseObject({ content: z.array(z.unknown()) });

/**
 * The text of a tool result as a session shows it: Claude Code's hook gives the result's text, its content
 * blocks or the parsed object, and Codex's item gives `{ content: [...] }`.
 */
export function toolResultText(response: unknown): string | null {
  if (typeof response === 'string') return response;
  const blocks = Array.isArray(response)
    ? response
    : (WithContent.safeParse(response).data?.content ?? null);
  if (blocks !== null)
    return blocks
      .flatMap((block) => {
        const parsed = TextBlock.safeParse(block);
        return parsed.success ? [parsed.data.text] : [];
      })
      .join('');
  if (typeof response === 'object' && response !== null) return JSON.stringify(response);
  return null;
}

/** Whether a `prepare_file_upload` call's arguments are the ones this upload's open step named. */
export function awaitsResultOf(upload: AgentUpload, input: unknown): boolean {
  const step = upload.step;
  if (step === null || step.closed || !step.named.asked) return false;
  const args = z.looseObject({ filename: z.string(), size: z.number() }).safeParse(input);
  return (
    args.success && args.data.filename === step.named.filename && args.data.size === step.named.size
  );
}

/**
 * Linear answered the upload request the agent made for the open step: sends the picture's bytes to the signed
 * address at once, since it lasts a minute. `text` is null when the call failed. Never throws: a picture that
 * can't be sent is left out of the comment and named there.
 */
export async function takeUploadResult(
  upload: AgentUpload,
  text: string | null,
  send: typeof fetch,
): Promise<void> {
  const step = upload.step;
  if (step === null || step.closed) return;
  step.closed = true;
  try {
    if (text === null) throw new LinearUploadError('Linear refused the upload request.');
    const prepared = parsePreparedPicture(text, step.picture.name);
    await sendPicture(prepared, step.bytes, send);
    upload.shown.push({
      label: step.picture.label,
      markdown: prepared.markdown,
      assetUrl: prepared.assetUrl,
    });
  } catch (error) {
    fail(upload, step, error instanceof Error ? error.message : String(error));
  } finally {
    step.finish();
  }
}

/**
 * Ends the open step before the next is named: waits for a picture being sent, and gives the upload request
 * and its result `RESULT_WAIT_MS` to arrive. An agent may make the request and its call back to 10db at once,
 * so a request the guard has not seen yet is waited for too; one that never comes counts as failed.
 */
export async function closeUploadStep(upload: AgentUpload, clock: Clock): Promise<void> {
  const step = upload.step;
  if (step === null) return;
  if (step.closed) {
    await step.done;
    return;
  }
  const timer = clock.setTimeout(() => {
    if (step.closed) return;
    step.closed = true;
    fail(
      upload,
      step,
      step.named.asked
        ? "Linear's answer to the upload request did not reach 10db"
        : 'the upload was not asked of Linear',
    );
    step.finish();
  }, RESULT_WAIT_MS);
  await step.done;
  timer.cancel();
}
