import { mintId, type InboxItemDto, type PassPageDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { inboxItemDto } from '../../test/fixtures';
import {
  askItem,
  minutesBeforeNow,
  pageTurn,
  pagesByStatus,
  passPageDto,
  PASS_NOW,
} from '../../test/pass-fixtures';
import { clockTime, pageStatus, PageStatus } from './page-status';

const pages = pagesByStatus();
const now = Date.parse(PASS_NOW);
const people = passPageDto({ title: 'People: UI work', area: 'People', route: '/people' });
const inPass = [...Object.values(pages), people];

describe('pageStatus', () => {
  it.each<{
    name: string;
    page: PassPageDto;
    items?: InboxItemDto[];
    median?: number | null;
    pass?: PassPageDto[];
    status: PageStatus;
    color: string;
    line: string;
    needsYou: boolean;
  }>([
    {
      name: 'a page never spoken to',
      page: pages.notStarted,
      status: PageStatus.NotStarted,
      color: 'gray',
      line: 'Not started',
      needsYou: false,
    },
    {
      name: 'a working page, beside the pass median',
      page: pages.working,
      median: 6,
      status: PageStatus.Working,
      color: 'blue',
      line: 'Working · 4 min · median 6',
      needsYou: false,
    },
    {
      name: 'a working page before any turn has ended',
      page: pages.working,
      median: null,
      status: PageStatus.Working,
      color: 'blue',
      line: 'Working · 4 min',
      needsYou: false,
    },
    {
      name: 'a working page while the turns that ended took under a minute: no median yet',
      page: pages.working,
      median: 0,
      status: PageStatus.Working,
      color: 'blue',
      line: 'Working · 4 min',
      needsYou: false,
    },
    {
      name: 'a page spoken to whose session is still starting',
      page: passPageDto({ spokenTo: true, state: 'STARTING' }),
      status: PageStatus.Working,
      color: 'blue',
      line: 'Starting',
      needsYou: false,
    },
    {
      name: 'a Ready page answered while its session was closed, queued with the message',
      page: { ...pages.ready, state: 'QUEUED', nextActionKind: 'feedback' },
      status: PageStatus.Working,
      color: 'blue',
      line: 'Starting',
      needsYou: false,
    },
    {
      name: 'a Ready page',
      page: pages.ready,
      status: PageStatus.Ready,
      color: 'yellow',
      line: 'Ready · 3 min',
      needsYou: true,
    },
    {
      name: 'a page Ready this minute',
      page: {
        ...pages.ready,
        turn: pageTurn({ endedAt: PASS_NOW, readyAt: PASS_NOW }),
      },
      status: PageStatus.Ready,
      color: 'yellow',
      line: 'Ready',
      needsYou: true,
    },
    {
      name: 'a page whose agent asks a question',
      page: pages.asks,
      items: [askItem(pages.asks)],
      status: PageStatus.Asks,
      color: 'yellow',
      line: 'Asks a question',
      needsYou: true,
    },
    {
      name: 'a page whose agent asks for permission',
      page: pages.working,
      items: [askItem(pages.working, { kind: 'permission' })],
      status: PageStatus.Asks,
      color: 'yellow',
      line: 'Asks for permission',
      needsYou: true,
    },
    {
      name: "another page's question, an answered one, or a check item is not this page's ask",
      page: pages.working,
      items: [
        askItem(pages.ready),
        askItem(pages.working, { state: 'RESOLVED' }),
        askItem(pages.working, { kind: 'check' }),
        inboxItemDto(),
      ],
      median: null,
      status: PageStatus.Working,
      color: 'blue',
      line: 'Working · 4 min',
      needsYou: false,
    },
    {
      name: 'a failed turn, in failureLine’s words with what Retry Turn does, never yellow',
      page: pages.failed,
      status: PageStatus.Failed,
      color: 'red',
      line: 'The session kept crashing or could not start. Retry Turn sends your last message again.',
      needsYou: true,
    },
    {
      name: 'a failed turn of no known kind',
      page: { ...pages.failed, failure: { failureKind: null, retryItemId: mintId('InboxItem') } },
      status: PageStatus.Failed,
      color: 'red',
      line: 'The turn failed. Retry Turn sends your last message again.',
      needsYou: true,
    },
    {
      name: 'a turn paused for a usage limit, which needs nothing',
      page: pages.paused,
      status: PageStatus.Paused,
      color: 'orange',
      line: `Paused: usage limit, resumes ${clockTime('2026-11-09T15:40:00.000Z')}`,
      needsYou: false,
    },
    {
      name: 'a pause with no end known',
      page: { ...pages.paused, pausedUntil: null },
      status: PageStatus.Paused,
      color: 'orange',
      line: 'Paused: usage limit',
      needsYou: false,
    },
    {
      name: 'a turn the builder stopped, which waits for the next message',
      page: passPageDto({
        state: 'QUEUED',
        nextActionKind: 'resume',
        spokenTo: true,
        turn: pageTurn({ startedMinutesAgo: 5, endedAt: minutesBeforeNow(2) }),
      }),
      status: PageStatus.NotStarted,
      color: 'gray',
      line: 'Stopped',
      needsYou: false,
    },
    {
      name: 'a page whose sign-off is landing',
      page: { ...pages.ready, signOff: 'signing_off' },
      status: PageStatus.SigningOff,
      color: 'blue',
      line: 'Signing off…',
      needsYou: false,
    },
    {
      name: "a sign-off waiting for another page's turn, named by that page",
      page: {
        ...pages.ready,
        signOff: 'waiting',
        waitsFor: { taskId: people.taskId, title: people.title },
      },
      status: PageStatus.Waiting,
      color: 'blue',
      line: "Signing off: waiting for People's turn",
      needsYou: false,
    },
    {
      name: 'a sign-off waiting for a task the pass does not hold, named by its title',
      page: {
        ...pages.ready,
        signOff: 'waiting',
        waitsFor: { taskId: people.taskId, title: people.title },
      },
      pass: Object.values(pages),
      status: PageStatus.Waiting,
      color: 'blue',
      line: "Signing off: waiting for People: UI work's turn",
      needsYou: false,
    },
    {
      name: 'a signed-off page, even with a question still open from its run',
      page: { ...pages.asks, signOff: 'done' },
      items: [askItem(pages.asks)],
      status: PageStatus.SignedOff,
      color: 'green',
      line: 'Signed off',
      needsYou: false,
    },
  ])('$name', ({ page, items = [], median = 6, pass = inPass, status, color, line, needsYou }) => {
    expect(pageStatus(page, items, { now, medianTurnMinutes: median }, pass)).toEqual({
      status,
      color,
      line,
      needsYou,
    });
  });
});
