import {
  InboxKind,
  InboxState,
  PassPreview,
  PassSignOff,
  WorkstreamState,
  type InboxItemDto,
  type PassPageDto,
  type PassViewDto,
} from '@10db/contracts';
import type { MantineColor } from '@mantine/core';
import { passTurnFailureLine } from '../board/task-state';

// Workbench spec §4.3: a page's state in the queue, as one dot, one short line and whether it waits on
// the builder. The colors are DESIGN.md's: yellow waits on the builder, blue works, orange is paused,
// red failed or broke the preview, green signed off, gray not started.

/** Where a page is, as the queue orders and draws it. */
export const PageStatus = {
  /** The agent asks a question or for permission. */
  Asks: 'asks',
  /** The turn could not go on; Retry Turn sends the last message again. */
  Failed: 'failed',
  /** Ready, but its turn broke the preview (spec §8.2): Send to Agent offers the break. */
  PreviewBroken: 'preview_broken',
  Ready: 'ready',
  SigningOff: 'signing_off',
  /** Signing off, waiting for another page's turn to release shared code. */
  Waiting: 'waiting',
  Paused: 'paused',
  Working: 'working',
  /** Not spoken to yet, or stopped by the builder and waiting for the next message. */
  NotStarted: 'not_started',
  SignedOff: 'signed_off',
} as const;
export type PageStatus = (typeof PageStatus)[keyof typeof PageStatus];

export interface PageState {
  readonly status: PageStatus;
  readonly color: MantineColor;
  readonly line: string;
  /** Whether the page waits on the builder: its name is drawn heavier and it counts on the sidebar. */
  readonly needsYou: boolean;
}

/** Each status's dot color, and whether it waits on the builder. */
export const PAGE_LOOK: Readonly<
  Record<PageStatus, { readonly color: MantineColor; readonly needsYou: boolean }>
> = {
  [PageStatus.Asks]: { color: 'yellow', needsYou: true },
  [PageStatus.Failed]: { color: 'red', needsYou: true },
  [PageStatus.PreviewBroken]: { color: 'red', needsYou: true },
  [PageStatus.Ready]: { color: 'yellow', needsYou: true },
  [PageStatus.SigningOff]: { color: 'blue', needsYou: false },
  [PageStatus.Waiting]: { color: 'blue', needsYou: false },
  [PageStatus.Paused]: { color: 'orange', needsYou: false },
  [PageStatus.Working]: { color: 'blue', needsYou: false },
  [PageStatus.NotStarted]: { color: 'gray', needsYou: false },
  [PageStatus.SignedOff]: { color: 'green', needsYou: false },
};

export interface PageStatusClock {
  /** Now, in epoch milliseconds. */
  readonly now: number;
  /** The pass's median turn in whole minutes; null before a turn has ended. */
  readonly medianTurnMinutes: number | null;
}

const MINUTE_MS = 60_000;

const CLOCK = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });

/** "3:40 PM": when a pause ends, in the builder's time. */
export function clockTime(at: string): string {
  return CLOCK.format(new Date(at));
}

function minutesSince(at: string, now: number): number {
  return Math.max(0, Math.floor((now - Date.parse(at)) / MINUTE_MS));
}

/** A run working now, or about to: a session starting, running, handing off or being recovered. */
const WORKING_STATES: ReadonlySet<WorkstreamState> = new Set([
  WorkstreamState.Starting,
  WorkstreamState.Running,
  WorkstreamState.HandingOff,
  WorkstreamState.Recovering,
]);

/** An open question or permission ask from the page's run, if any: the Workbench answers it in place. */
export function askOf(page: PassPageDto, items: readonly InboxItemDto[]): InboxItemDto | undefined {
  if (page.workstreamId === null) return undefined;
  const run = page.workstreamId;
  return items.find(
    (item) =>
      item.state === InboxState.Open &&
      (item.kind === InboxKind.Question || item.kind === InboxKind.Permission) &&
      item.targets.some((target) => target.workstreamId === run),
  );
}

function state(status: PageStatus, line: string): PageState {
  return { status, line, ...PAGE_LOOK[status] };
}

/** Whether the page is working: its run is, a turn is open, or a message is queued to start one. */
function working(page: PassPageDto): boolean {
  if (page.state !== null && WORKING_STATES.has(page.state)) return true;
  if (page.turn === null) return page.spokenTo;
  return page.turn.endedAt === null || page.nextActionKind === 'feedback';
}

/** What the queue reads of the pass beside the page: its pages, and how its preview loaded last. */
export type PassAround = Pick<PassViewDto, 'pages' | 'preview'>;

function workingLine(page: PassPageDto, clock: PageStatusClock, pass: PassAround): string {
  const turn = page.turn;
  // A message is on its way into a session that has not started its turn yet.
  if (turn === null || (turn.endedAt !== null && page.nextActionKind === 'feedback'))
    return 'Starting';
  // While the preview is broken, a page mid-turn may be half written: that is expected (spec §8.2).
  const changing =
    pass.preview === PassPreview.Broken || page.preview !== null ? ' · changing' : '';
  const elapsed = `Working${changing} · ${String(minutesSince(turn.startedAt, clock.now))} min`;
  // Turns that ended in under a minute measure nothing yet: "median 0" says no more than nothing.
  const median = clock.medianTurnMinutes;
  return median === null || median < 1 ? elapsed : `${elapsed} · median ${String(median)}`;
}

/** A page's state before any sign-off: what its run, its turn and the Inbox say. */
function unsignedState(
  page: PassPageDto,
  items: readonly InboxItemDto[],
  clock: PageStatusClock,
  pass: PassAround,
): PageState {
  const ask = askOf(page, items);
  if (ask)
    return state(
      PageStatus.Asks,
      ask.kind === InboxKind.Permission ? 'Asks for permission' : 'Asks a question',
    );
  if (page.failure) return state(PageStatus.Failed, passTurnFailureLine(page.failure.failureKind));
  if (page.state === WorkstreamState.PausedLimit)
    return state(
      PageStatus.Paused,
      page.pausedUntil === null
        ? 'Paused: usage limit'
        : `Paused: usage limit, resumes ${clockTime(page.pausedUntil)}`,
    );
  const readyAt = page.turn?.readyAt ?? null;
  if (page.state === WorkstreamState.WaitingHuman && readyAt !== null) {
    if (page.preview !== null)
      return state(PageStatus.PreviewBroken, `Preview broken: \`${page.preview.route}\``);
    const waited = minutesSince(readyAt, clock.now);
    return state(PageStatus.Ready, waited === 0 ? 'Ready' : `Ready · ${String(waited)} min`);
  }
  if (working(page)) return state(PageStatus.Working, workingLine(page, clock, pass));
  return state(PageStatus.NotStarted, page.turn === null ? 'Not started' : 'Stopped');
}

/**
 * "People's turn": the turn a waiting sign-off waits for, named by its page when the pass holds it,
 * else by its task's title.
 */
function waitedFor(waitsFor: NonNullable<PassPageDto['waitsFor']>, pass: PassAround) {
  const page = pass.pages.find((candidate) => candidate.taskId === waitsFor.taskId);
  return `${page?.area ?? waitsFor.title}'s turn`;
}

type SignOffState = (
  page: PassPageDto,
  items: readonly InboxItemDto[],
  clock: PageStatusClock,
  pass: PassAround,
) => PageState;

/**
 * How each sign-off state reads. A page not signed off reads what its run, its turn and the Inbox say;
 * a sign-off state added to the contract must say how it reads here.
 */
const BY_SIGN_OFF: Readonly<Record<PassSignOff, SignOffState>> = {
  [PassSignOff.None]: unsignedState,
  [PassSignOff.SigningOff]: () => state(PageStatus.SigningOff, 'Signing off…'),
  [PassSignOff.Waiting]: (page, _items, _clock, pass) =>
    state(
      PageStatus.Waiting,
      page.waitsFor === null
        ? "Signing off: waiting for another page's turn"
        : `Signing off: waiting for ${waitedFor(page.waitsFor, pass)}`,
    ),
  [PassSignOff.Done]: () => state(PageStatus.SignedOff, 'Signed off'),
};

/**
 * One page's state in the queue, from the page, the open Inbox items of the pass's project and the
 * pass around it: an ask is an item that targets the page's run, a waiting sign-off names the page
 * it waits for, and a broken preview makes a working page's line say it is changing.
 */
export function pageStatus(
  page: PassPageDto,
  items: readonly InboxItemDto[],
  clock: PageStatusClock,
  pass: PassAround,
): PageState {
  return BY_SIGN_OFF[page.signOff](page, items, clock, pass);
}
