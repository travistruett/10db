import { z } from 'zod';
import { TaskId } from './ids';

// Shape spec §5.5: see_screen. A session looks at the app through a screenshot the app's own window
// renders; it never gets a browser, a click or a command. These are the words the tool, the daemon
// and the window share.

type ValueOf<T> = T[keyof T];

/** The screens a session may ask to see: the four views and one task's drawer. */
export const ScreenName = {
  Factory: 'factory',
  Board: 'board',
  Inbox: 'inbox',
  Task: 'task',
  Plan: 'plan',
} as const;
export type ScreenName = ValueOf<typeof ScreenName>;

/**
 * The window a screen is drawn in. The bounds keep an image inside what a model reads well and the
 * API takes (at most 2000 px a side when many images are sent), and keep one image small.
 */
export const SCREEN_WIDTH = { min: 480, max: 1600, default: 1200 } as const;
export const SCREEN_HEIGHT = { min: 400, max: 2000, default: 900 } as const;

/** Decoded size of one screenshot the daemon accepts. */
export const SCREEN_IMAGE_MAX_BYTES = 1_500_000;

/** How many screenshots one conversation may take; each stays in the session's context. */
export const SCREENS_PER_CONVERSATION = 12;

const Width = z.number().int().min(SCREEN_WIDTH.min).max(SCREEN_WIDTH.max);
const Height = z.number().int().min(SCREEN_HEIGHT.min).max(SCREEN_HEIGHT.max);

/** `see_screen`: which screen, and the window. A task's drawer needs the task; no other screen takes one. */
export const SeeScreenInput = z
  .object({
    screen: z.enum(ScreenName),
    taskId: TaskId.optional(),
    width: Width.default(SCREEN_WIDTH.default),
    height: Height.default(SCREEN_HEIGHT.default),
  })
  .refine((input) => (input.screen === ScreenName.Task) === (input.taskId !== undefined), {
    message: 'The task screen takes a taskId, and no other screen does',
    path: ['taskId'],
  });
export type SeeScreenInput = z.infer<typeof SeeScreenInput>;

export const ScreenMediaType = { Png: 'image/png', Jpeg: 'image/jpeg' } as const;
export type ScreenMediaType = ValueOf<typeof ScreenMediaType>;

/** What the window posts once it has drawn a screen: the image in base64, and its size in pixels. */
export const ScreenImageInput = z.object({
  mediaType: z.enum(ScreenMediaType),
  data: z.string().min(1),
  width: z
    .number()
    .int()
    .min(1)
    .max(SCREEN_WIDTH.max * 2),
  height: z
    .number()
    .int()
    .min(1)
    .max(SCREEN_HEIGHT.max * 2),
});
export type ScreenImageInput = z.infer<typeof ScreenImageInput>;

/** What the window posts when it could not draw a screen: the reason the session is told. */
export const ScreenRefusalInput = z.object({ reason: z.string().min(1).max(300) });
export type ScreenRefusalInput = z.infer<typeof ScreenRefusalInput>;

/**
 * A request for the window to draw, as the daemon hands it over. `token` reads the screen's data
 * and nothing else: only the GET routes a screen needs, never the digest (a read that moves a mark).
 */
export const ScreenRenderRequest = z.object({
  id: z.string().min(1),
  screen: z.enum(ScreenName),
  projectId: z.string().min(1),
  taskId: TaskId.optional(),
  shapeId: z.string().min(1),
  width: Width,
  height: Height,
  token: z.string().min(1),
});
export type ScreenRenderRequest = z.infer<typeof ScreenRenderRequest>;

/** The body of a transcript row of kind `screen`: where the image is kept, never the image. */
export const ScreenMessageBody = z.object({
  screen: z.enum(ScreenName),
  taskId: TaskId.optional(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  name: z.string().regex(/^[0-9]{4}\.(png|jpg)$/),
  mediaType: z.enum(ScreenMediaType),
});
export type ScreenMessageBody = z.infer<typeof ScreenMessageBody>;
