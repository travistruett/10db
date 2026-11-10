import { describe, expect, it } from 'vitest';
import { announcements, type AnnouncedPage } from './announcements';
import { PageStatus } from './page-status';

const S = PageStatus;

function page(taskId: string, area: string, status: PageStatus, line = ''): AnnouncedPage {
  return { taskId, area, status, line };
}

describe('announcements', () => {
  it.each<{ name: string; before: AnnouncedPage[]; now: AnnouncedPage[]; said: string[] }>([
    {
      name: 'a page that turns Ready',
      before: [page('a', 'Settings', S.Working)],
      now: [page('a', 'Settings', S.Ready)],
      said: ['Settings is ready'],
    },
    {
      name: 'a page that asks a question',
      before: [page('b', 'People', S.Working)],
      now: [page('b', 'People', S.Asks, 'Asks a question')],
      said: ['People asks a question'],
    },
    {
      name: 'a page that asks for permission',
      before: [page('b', 'People', S.Working)],
      now: [page('b', 'People', S.Asks, 'Asks for permission')],
      said: ['People asks for permission'],
    },
    {
      name: 'a page whose turn failed',
      before: [page('c', 'Billing', S.Working)],
      now: [page('c', 'Billing', S.Failed)],
      said: ['Billing failed'],
    },
    {
      name: 'two at once, in queue order',
      before: [page('a', 'Settings', S.Working), page('c', 'Billing', S.Working)],
      now: [page('c', 'Billing', S.Failed), page('a', 'Settings', S.Ready)],
      said: ['Billing failed', 'Settings is ready'],
    },
    {
      name: 'a page that stays Ready says nothing again',
      before: [page('a', 'Settings', S.Ready)],
      now: [page('a', 'Settings', S.Ready)],
      said: [],
    },
    {
      name: 'working, paused, signing off and signed off are never said',
      before: [
        page('a', 'Settings', S.NotStarted),
        page('b', 'People', S.Working),
        page('c', 'Billing', S.Ready),
        page('d', 'Home', S.SigningOff),
      ],
      now: [
        page('a', 'Settings', S.Working),
        page('b', 'People', S.Paused),
        page('c', 'Billing', S.SigningOff),
        page('d', 'Home', S.SignedOff),
      ],
      said: [],
    },
    {
      name: 'a page added Ready is said',
      before: [],
      now: [page('a', 'Settings', S.Ready)],
      said: ['Settings is ready'],
    },
  ])('$name', ({ before, now, said }) => {
    expect(announcements(before, now)).toEqual(said);
  });
});
