import type { AreaDef, PassStartDto } from '@10db/contracts';
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { projectViewDto } from '../../test/fixtures';
import { passStartDto } from '../../test/pass-fixtures';
import { renderWithRouter } from '../../test/theme';
import { StartLines } from './start-lines';
import type { PickTicks } from './start-pass-rules';

const areas: AreaDef[] = [
  { name: 'settings', globs: ['src/settings/**'], role: 'page', route: '/settings' },
  { name: 'people', globs: ['lib/people/**'], role: 'page', route: '/people' },
  { name: 'src', globs: ['src/**'], role: 'shared' },
];
const project = projectViewDto({ areas, baseBranch: 'main' });
const quiet: PassStartDto = passStartDto({
  pages: [
    { area: 'settings', route: '/settings', lastChangedAt: null, uncommitted: 3, heldBy: null },
    { area: 'people', route: '/people', lastChangedAt: null, uncommitted: 0, heldBy: null },
  ],
  otherUncommitted: 0,
  lacks: [],
});
const settings: PickTicks = { pages: ['settings'], tasks: [] };
const people: PickTicks = { pages: ['people'], tasks: [] };
const none: PickTicks = { pages: [], tasks: [] };

const DIRT = "settings: 3 files already changed in your folder will be part of this page's work.";
const OTHER = '12 other changed files stay as they are.';
const SHARED = "Files under settings count as settings', not as shared src.";
const DOCKER = 'Docker is off: the gate needs it.';
const AHEAD = 'build has 4 commits origin/main lacks: the pull request will carry them.';
const NO_APP = 'No app address: Open Page has nowhere to go.';
const UNCHECKED = 'No changed-files check: turns run unchecked.';

describe('StartLines', () => {
  it.each<{ name: string; ticks: PickTicks; start: Partial<PassStartDto>; lines: string[] }>([
    { name: 'nothing to say', ticks: people, start: {}, lines: [] },
    { name: "a ticked page's changed files", ticks: settings, start: {}, lines: [DIRT, SHARED] },
    {
      name: 'the changed files elsewhere',
      ticks: none,
      start: { otherUncommitted: 12 },
      lines: [OTHER],
    },
    {
      name: 'what the project lacks',
      ticks: none,
      start: {
        lacks: [
          { kind: 'docker_off', count: null, branch: null },
          { kind: 'ahead_of_base', count: 4, branch: 'build' },
          { kind: 'no_app_url', count: null, branch: null },
          { kind: 'no_changed_check', count: null, branch: null },
        ],
      },
      lines: [DOCKER, AHEAD, NO_APP, UNCHECKED],
    },
  ])('says $name, and nothing else', async ({ ticks, start, lines }) => {
    await renderWithRouter(
      <StartLines ticks={ticks} start={{ ...quiet, ...start }} project={project} />,
    );
    const said = [DIRT, OTHER, SHARED, DOCKER, AHEAD, NO_APP, UNCHECKED].filter(
      (line) => screen.queryByText(line) !== null,
    );
    expect(said).toEqual(lines);
  });

  it.each([
    { kind: 'docker_off', line: DOCKER },
    { kind: 'no_app_url', line: NO_APP },
    { kind: 'no_changed_check', line: UNCHECKED },
  ] as const)('links $kind to Settings › General', async ({ kind, line }) => {
    const { router } = await renderWithRouter(
      <StartLines
        ticks={none}
        start={{ ...quiet, lacks: [{ kind, count: null, branch: null }] }}
        project={project}
      />,
    );
    expect(screen.getByText(line)).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Open Settings' }));
    expect(router.state.location.pathname).toBe('/settings/general');
  });
});
