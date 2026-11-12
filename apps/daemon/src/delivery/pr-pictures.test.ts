import { mintId, type ScreenKind, type TaskScreenDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { picturePlan, picturesSection } from './pr-pictures';

const taskId = mintId('Task');

function screen(kind: ScreenKind, route: string, at: number, width = 1440): TaskScreenDto {
  return {
    id: mintId('TaskScreen'),
    taskId,
    turnId: null,
    turnSeq: null,
    kind,
    route,
    viewport: { width, height: 900 },
    theme: 'default',
    width,
    height: 900,
    size: 10,
    sha256: String(at).padStart(64, '0'),
    keptSha: null,
    createdAt: `2026-11-12T10:0${String(at)}:00.000Z`,
  };
}

describe('picturePlan', () => {
  it.each<{
    name: string;
    screens: TaskScreenDto[];
    want: [string, string | null, string | null][];
  }>([
    {
      name: 'a route with a before and an after',
      screens: [screen('before', '/settings', 1), screen('after', '/settings', 2)],
      want: [['/settings', '0000001', '0000002']],
    },
    {
      name: 'the first before and the last after, turn pictures left out',
      screens: [
        screen('before', '/settings', 1),
        screen('before', '/settings', 2),
        screen('turn', '/settings', 3),
        screen('after', '/settings', 4),
        screen('after', '/settings', 5),
      ],
      want: [['/settings', '0000001', '0000005']],
    },
    {
      name: 'a route with only an after',
      screens: [screen('after', '/people', 1)],
      want: [['/people', null, '0000001']],
    },
    {
      name: 'only the first viewport of a route',
      screens: [
        screen('before', '/settings', 1),
        screen('before', '/settings', 2, 390),
        screen('after', '/settings', 3, 390),
        screen('after', '/settings', 4),
      ],
      want: [['/settings', '0000001', '0000004']],
    },
    { name: 'no before or after', screens: [screen('turn', '/settings', 1)], want: [] },
  ])('$name', ({ screens, want }) => {
    const plan = picturePlan([{ title: 'Settings: UI work', screens }]);
    expect(
      plan.map((p) => [
        p.route,
        p.before?.screen.sha256.slice(-7) ?? null,
        p.after?.screen.sha256.slice(-7) ?? null,
      ]),
    ).toEqual(want);
  });

  it('names each file by page, route and kind, unique across pages', () => {
    const plan = picturePlan([
      { title: 'Settings', screens: [screen('before', '/settings/[id]', 1)] },
      { title: 'Home', screens: [screen('after', '/', 2)] },
    ]);
    expect(plan.map((p) => p.before?.name ?? p.after?.name)).toEqual([
      '1-settings-id-before.png',
      '2-home-after.png',
    ]);
  });
});

describe('picturesSection', () => {
  it('shows each page before beside after, linked at the pictures commit', () => {
    const plan = picturePlan([
      {
        title: 'Settings: UI work',
        screens: [screen('before', '/settings', 1), screen('after', '/settings', 2)],
      },
      { title: 'People', screens: [screen('after', '/people', 3)] },
    ]);
    const sha = 'a'.repeat(40);
    const raw = (name: string) => `https://github.com/octo/app/blob/${sha}/${name}?raw=true`;
    expect(picturesSection('octo/app', sha, plan)).toBe(
      [
        '## Pictures',
        '',
        '**Settings: UI work** `/settings`',
        '',
        '| Before | After |',
        '| --- | --- |',
        `| ![Before](${raw('1-settings-before.png')}) | ![After](${raw('1-settings-after.png')}) |`,
        '',
        '**People** `/people`',
        '',
        '| Before | After |',
        '| --- | --- |',
        `| No before picture | ![After](${raw('2-people-after.png')}) |`,
      ].join('\n'),
    );
  });

  it('is empty with no pictures', () => {
    expect(picturesSection('octo/app', 'a'.repeat(40), [])).toBe('');
  });
});
