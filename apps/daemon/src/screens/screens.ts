import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  InvalidError,
  SCREEN_IMAGE_MAX_BYTES,
  SCREENS_PER_CONVERSATION,
  ScreenMediaType,
  ScreenName,
  ShapeId,
  ShapeMessageAuthor,
  ShapeMessageKind,
  type ScreenImageInput,
  type ScreenMessageBody,
  type SeeScreenInput,
} from '@10db/contracts';
import { getShape, getTask, insertShapeMessage, listShapeMessages } from '@10db/db';
import type { StateStore } from '../events';
import { ToolImages } from '../mcp';
import type { ScreenBroker } from './broker';
import { readImageHeader } from './image-check';
import { inlineBytesSpent } from './inline-budget';
import type { PictureLimits } from './picture-limits';

// Shape spec §5.5: see_screen. Asks the app's window for a picture of one of its screens, checks the
// picture, keeps it with the conversation (a file, and a transcript row that names it) and answers the
// session with it. A screen that can't be drawn is a refusal that says why, never a blank image.

export interface ScreenDeps {
  readonly state: StateStore;
  readonly broker: ScreenBroker;
  /** The data directory's `shapes` folder; a conversation's screens are in `<shape>/screens/`. */
  readonly filesDir: string;
}

export interface ScreenService {
  /**
   * Draws a screen for a conversation's session. Throws an InvalidError saying why when it can't. `limits` are
   * those of the account the session runs on, which the picture is held to.
   */
  see(shapeId: ShapeId, input: SeeScreenInput, limits: PictureLimits): Promise<ToolImages>;
  /** A kept screenshot by the name the transcript row gave it; null for any other name. */
  image(
    shapeId: ShapeId,
    name: string,
  ): { readonly bytes: Uint8Array; readonly mediaType: ScreenMediaType } | null;
}

const LABEL: Readonly<Record<ScreenName, string>> = {
  [ScreenName.Factory]: 'Factory',
  [ScreenName.Board]: 'Board',
  [ScreenName.Inbox]: 'Inbox',
  [ScreenName.Task]: "task's drawer",
  [ScreenName.Plan]: 'Plan',
};

const NAME = /^([0-9]{4})\.(png|jpg)$/;
const EXTENSION: Readonly<Record<ScreenMediaType, 'png' | 'jpg'>> = {
  [ScreenMediaType.Png]: 'png',
  [ScreenMediaType.Jpeg]: 'jpg',
};

const REASON_MAX = 300;
const cut = (text: string): string =>
  text.length <= REASON_MAX ? text : `${text.slice(0, REASON_MAX - 1)}…`;

export function createScreens(deps: ScreenDeps): ScreenService {
  const screensDir = (shapeId: ShapeId): string => join(deps.filesDir, shapeId, 'screens');

  const refuse = (shapeId: ShapeId, reason: string): never => {
    deps.state.write((ctx) => {
      insertShapeMessage(ctx, shapeId, {
        author: ShapeMessageAuthor.Claude,
        kind: ShapeMessageKind.Tool,
        body: `see_screen · refused · ${cut(reason)}`,
      });
    });
    throw new InvalidError(reason);
  };

  /** Why the picture can't be used, or the bytes when it can. */
  const checked = (
    image: ScreenImageInput,
    input: SeeScreenInput,
  ): { readonly bytes: Buffer } | { readonly problem: string } => {
    const bytes = Buffer.from(image.data, 'base64');
    if (bytes.length > SCREEN_IMAGE_MAX_BYTES)
      return {
        problem: `The picture the window drew is too large to keep (${String(bytes.length)} bytes; the most is ${String(SCREEN_IMAGE_MAX_BYTES)}). Ask for a smaller window.`,
      };
    const header = readImageHeader(bytes);
    if (header?.mediaType !== image.mediaType)
      return {
        problem:
          'What the window sent is not a PNG or a JPEG, so it was not shown. Try again; if it keeps happening, tell the builder.',
      };
    if (header.width !== image.width || header.height !== image.height)
      return {
        problem: `The picture says ${String(image.width)} by ${String(image.height)} and holds ${String(header.width)} by ${String(header.height)}, so it was not shown.`,
      };
    if (header.width > input.width || header.height > input.height)
      return {
        problem: `The picture is ${String(header.width)} by ${String(header.height)}, larger than the window it was asked for (${String(input.width)} by ${String(input.height)}), so it was not shown.`,
      };
    return { bytes };
  };

  return {
    async see(shapeId, input, limits) {
      const shape = getShape(deps.state.db, shapeId);
      const taken = listShapeMessages(deps.state.db, shapeId).filter(
        (m) => m.kind === ShapeMessageKind.Screen,
      ).length;
      if (taken >= SCREENS_PER_CONVERSATION)
        return refuse(
          shapeId,
          `This conversation already holds ${String(SCREENS_PER_CONVERSATION)} screens, and each stays in your context. Work from them, or ask the builder to start a new conversation.`,
        );
      if (input.taskId !== undefined) {
        const projectOfTask = (() => {
          try {
            return getTask(deps.state.db, input.taskId).projectId;
          } catch {
            return null;
          }
        })();
        if (projectOfTask !== shape.projectId)
          return refuse(shapeId, `Task ${input.taskId} is not in this project.`);
      }

      const outcome = await deps.broker.request({
        shapeId,
        projectId: shape.projectId,
        screen: input.screen,
        ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
        width: input.width,
        height: input.height,
      });
      if (!outcome.ok) return refuse(shapeId, outcome.reason);
      const result = checked(outcome.image, input);
      if ('problem' in result) return refuse(shapeId, result.problem);
      // Read after the await, with nothing awaited before the file is kept, so two calls can't both pass.
      if (
        inlineBytesSpent(deps.state, deps.filesDir, shapeId, limits) + result.bytes.length >
        limits.inlineMaxBytes
      )
        return refuse(
          shapeId,
          `This conversation has no room for another picture: every picture stays in your context, and a request can only carry so many under ${limits.limitText}. Work from the ones you have, or ask the builder to start a new conversation.`,
        );

      const dir = screensDir(shapeId);
      mkdirSync(dir, { recursive: true });
      const last = readdirSync(dir).reduce(
        (max, file) => Math.max(max, Number(NAME.exec(file)?.[1] ?? 0)),
        0,
      );
      const name = `${String(last + 1).padStart(4, '0')}.${EXTENSION[outcome.image.mediaType]}`;
      writeFileSync(join(dir, name), result.bytes, { flag: 'wx', mode: 0o600 });
      const body: ScreenMessageBody = {
        screen: input.screen,
        ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
        width: outcome.image.width,
        height: outcome.image.height,
        name,
        mediaType: outcome.image.mediaType,
      };
      const size = `${String(body.width)}×${String(body.height)}`;
      deps.state.write((ctx) => {
        insertShapeMessage(ctx, shapeId, {
          author: ShapeMessageAuthor.Claude,
          kind: ShapeMessageKind.Tool,
          body: `see_screen · ${input.screen} · ${size}`,
        });
        insertShapeMessage(ctx, shapeId, {
          author: ShapeMessageAuthor.Claude,
          kind: ShapeMessageKind.Screen,
          body: JSON.stringify(body),
        });
      });
      return new ToolImages(
        `The ${LABEL[input.screen]} at ${size}, with this project's data as it is now. It is a picture: nothing on it can be clicked or typed into.`,
        [{ mediaType: outcome.image.mediaType, data: outcome.image.data }],
      );
    },

    image(shapeId, name) {
      const match = NAME.exec(name);
      if (match === null || !ShapeId.safeParse(shapeId).success) return null;
      try {
        return {
          bytes: readFileSync(join(screensDir(shapeId), name)),
          mediaType: match[2] === 'jpg' ? ScreenMediaType.Jpeg : ScreenMediaType.Png,
        };
      } catch {
        return null;
      }
    },
  };
}
