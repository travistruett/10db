import { z } from 'zod';
import { ScreenViewport } from './task-screens';

// The browser a lane's session drives against the servers the lane started itself: five tools, each
// answering JSON text (a screenshot answers an image and its PNG's path).

type ValueOf<T> = T[keyof T];

export const BrowserToolName = {
  Open: 'browser_open',
  Snapshot: 'browser_snapshot',
  Act: 'browser_act',
  Upload: 'browser_upload',
  Screenshot: 'browser_screenshot',
} as const;
export type BrowserToolName = ValueOf<typeof BrowserToolName>;

export const BrowserAction = {
  Click: 'click',
  Fill: 'fill',
  Select: 'select',
  Check: 'check',
  Press: 'press',
} as const;
export type BrowserAction = ValueOf<typeof BrowserAction>;

/** A ref from the latest snapshot, as `[ref=e12]` prints it. */
export const ElementRef = z.string().regex(/^[A-Za-z0-9]{1,32}$/);

const ACTIONS_WITH_VALUE: readonly BrowserAction[] = [
  BrowserAction.Fill,
  BrowserAction.Select,
  BrowserAction.Press,
];

export const BrowserToolInputs = {
  [BrowserToolName.Open]: z.strictObject({
    url: z.string().min(1).max(2048),
    viewport: ScreenViewport.optional(),
  }),
  [BrowserToolName.Snapshot]: z.strictObject({}),
  [BrowserToolName.Act]: z
    .strictObject({
      ref: ElementRef,
      action: z.enum(BrowserAction),
      /** The text to fill, the option to select, or the key to press; refused for click and check. */
      value: z.string().max(10_000).optional(),
      /** Accepts a `confirm` or `prompt` the action raises; absent, it is dismissed. */
      dialog: z.literal('accept').optional(),
    })
    .superRefine((input, ctx) => {
      const needsValue = ACTIONS_WITH_VALUE.includes(input.action);
      if (needsValue && input.value === undefined)
        ctx.addIssue({
          code: 'custom',
          path: ['value'],
          message: `The ${input.action} action needs a value`,
        });
      if (!needsValue && input.value !== undefined)
        ctx.addIssue({
          code: 'custom',
          path: ['value'],
          message: `The ${input.action} action takes no value`,
        });
    }),
  [BrowserToolName.Upload]: z.strictObject({
    ref: ElementRef,
    paths: z.array(z.string().min(1).max(4096)).min(1).max(10),
  }),
  [BrowserToolName.Screenshot]: z.strictObject({
    fullPage: z.boolean().optional(),
    note: z.string().max(500).optional(),
  }),
} as const satisfies Record<BrowserToolName, z.ZodType>;

const REACH =
  'It reaches only servers this lane started (a process of its own, or a Docker Compose stack started from its copy or temp dir) on localhost, 127.0.0.1 or [::1]; anything else is refused, and a refusal is final and says why.';

export const BROWSER_TOOL_DESCRIPTIONS: Record<BrowserToolName, string> = {
  [BrowserToolName.Open]: `Open a page in the lane's own browser and answer with a snapshot of it. ${REACH} Pass a viewport to set the window size. Refs in the snapshot come from this answer and stay valid until the next snapshot.`,
  [BrowserToolName.Snapshot]: `Read the current page again as an accessibility snapshot with a [ref=...] on each element you can act on. Refs come from the latest snapshot: take a new one after the page changes. ${REACH}`,
  [BrowserToolName.Act]: `Click, fill, select, check or press a key on an element named by a ref from the latest snapshot, then answer with a new snapshot. fill, select and press need a value; click and check take none. A confirm or prompt the action raises is dismissed unless dialog is "accept". ${REACH}`,
  [BrowserToolName.Upload]: `Put files into a file input named by a ref from the latest snapshot. An upload takes files in the lane's copy or temp dir; any other path is refused, and a refusal is final and says why. ${REACH}`,
  [BrowserToolName.Screenshot]: `Take a picture of the current page. It is kept on the task as evidence, sent to you as an image when it fits the account's limits, and its PNG's path is in every answer. Pass fullPage for the whole page and a note to say what it shows. ${REACH}`,
};

/** The most characters of a snapshot an answer carries; a longer one is cut and says so. */
export const SNAPSHOT_MAX_CHARS = 24_000;

/** The most pages a session's browser holds open; a fifth closes the oldest. */
export const BROWSER_MAX_PAGES = 4;

export const BrowserDialog = z.object({
  type: z.enum(['alert', 'beforeunload', 'confirm', 'prompt']),
  message: z.string(),
  answer: z.enum(['accepted', 'dismissed']),
});
export type BrowserDialog = z.infer<typeof BrowserDialog>;

/** What every tool but `browser_screenshot` answers, as JSON text. */
export const BrowserAnswer = z.object({
  /** The current page: its URL after redirects, its title, and the status of its last navigation. */
  page: z.object({ url: z.string(), title: z.string(), status: z.int().nullable() }).nullable(),
  /** Every open page, oldest first; `current` marks the one the snapshot reads. */
  pages: z.array(z.object({ url: z.string(), title: z.string(), current: z.boolean() })),
  snapshot: z.string().nullable(),
  snapshotCut: z.boolean(),
  /** Each request refused since the last answer: `<method> <origin><path>: <why>`, never the query. */
  refused: z.array(z.string()),
  dialogs: z.array(BrowserDialog),
  /** What else the lane should know: cookies cleared after an idle close, a page closed for a fifth. */
  notes: z.array(z.string()),
});
export type BrowserAnswer = z.infer<typeof BrowserAnswer>;
