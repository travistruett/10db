import type { AreaDef, HazardDef, ProposedArea } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { keepPageProposals } from './propose-pages';

// Workbench spec §4.2, §7.1: Propose Page Areas offers the proposer's pages a project does not have.

const page = (name: string, glob: string, route?: string): ProposedArea => ({
  name,
  globs: [glob],
  role: 'page',
  ...(route === undefined ? {} : { route }),
  reason: `${name} is a screen.`,
});

const AREAS: AreaDef[] = [
  { name: 'settings', globs: ['app/settings/**'], role: 'page', route: '/settings' },
  { name: 'lib', globs: ['lib/**'] },
  { name: 'src', globs: ['**'], catchAll: true },
];
const HAZARDS: HazardDef[] = [{ name: 'deps', globs: ['pnpm-lock.yaml'], commands: [] }];

describe('keepPageProposals', () => {
  it.each<{ name: string; proposed: ProposedArea[]; kept: string[]; skipped: [string, RegExp][] }>([
    {
      name: 'keeps a page the project lacks',
      proposed: [page('people', 'app/people/**', '/people')],
      kept: ['people'],
      skipped: [],
    },
    {
      name: 'leaves out what is not a page, silently',
      proposed: [
        { name: 'shared', globs: ['app/_parts/**'], role: 'shared', reason: 'Shared.' },
        { name: 'api', globs: ['app/api/**'], reason: 'Endpoints.' },
      ],
      kept: [],
      skipped: [],
    },
    {
      name: 'skips a page named as an area is',
      proposed: [page('settings', 'app/account/**')],
      kept: [],
      skipped: [['settings', /An area named "settings" exists/]],
    },
    {
      name: 'skips a page named as a hazard is',
      proposed: [page('deps', 'app/deps/**')],
      kept: [],
      skipped: [['deps', /A hazard named "deps" exists/]],
    },
    {
      name: 'skips a page that shares files with a page the project has',
      proposed: [page('account', 'app/settings/account/**')],
      kept: [],
      skipped: [['account', /shares files with page "settings"/]],
    },
    {
      name: 'skips a page that holds the same files as an area that is not one',
      proposed: [page('library', 'lib/**')],
      kept: [],
      skipped: [['library', /Area "lib" holds these files; mark it a page/]],
    },
    {
      name: 'skips a page at a route another page shows',
      proposed: [page('prefs', 'app/prefs/**', '/settings')],
      kept: [],
      skipped: [['prefs', /Page "settings" shows \/settings/]],
    },
    {
      name: 'keeps the first of two proposed pages that share files',
      proposed: [page('people', 'app/people/**'), page('team', 'app/people/team/**')],
      kept: ['people'],
      skipped: [['team', /shares files with page "people"/]],
    },
  ])('$name', ({ proposed, kept, skipped }) => {
    const result = keepPageProposals(proposed, { areas: AREAS, hazards: HAZARDS });

    expect(result.pages.map((p) => p.name)).toEqual(kept);
    expect(result.skipped.map((s) => s.name)).toEqual(skipped.map(([name]) => name));
    for (const [n, [, reason]] of skipped.entries())
      expect(result.skipped[n]?.reason).toMatch(reason);
  });
});
